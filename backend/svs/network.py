"""LAN helpers for running with real hardware on a router or phone hotspot.

The ESP32-S3 hub and the laptop join the same Wi-Fi access point. The hub must find the
laptop's MQTT broker, whose IP changes from network to network (hotspots especially), so
the broker is advertised over mDNS / DNS-SD:

* service ``_mqtt._tcp.local.`` with instance name ``svs-gateway`` and TXT ``svs=1``
* hostname ``svs-gateway.local``

Firmware can use either ``MDNS.queryService("mqtt", "tcp")`` (and check ``svs=1``) or
``MDNS.queryHost("svs-gateway")``, with a hard-coded IP as a fallback.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass

from zeroconf import IPVersion, ServiceInfo, ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

SERVICE_TYPE = "_mqtt._tcp.local."
INSTANCE = "svs-gateway"
HOSTNAME = "svs-gateway.local."


def lan_ipv4_addresses() -> list[str]:
    """IPv4 addresses of this machine that other devices on the LAN can reach."""
    found: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except socket.gaierror:
        pass
    # The address used for the default route (no packet is actually sent for UDP connect).
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            found.add(s.getsockname()[0])
        except OSError:
            pass
    usable = []
    for ip in found:
        addr = ipaddress.ip_address(ip)
        if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            continue
        usable.append(ip)
    return sorted(usable, key=lambda ip: (not ipaddress.ip_address(ip).is_private, ip))


class BrokerAdvertiser:
    """Advertises the broker on the LAN via mDNS while it runs."""

    def __init__(self, port: int, addresses: list[str] | None = None, instance: str = INSTANCE) -> None:
        self.port = port
        self.addresses = addresses or lan_ipv4_addresses()
        self.instance = instance
        self._zc: AsyncZeroconf | None = None
        self._info: ServiceInfo | None = None

    async def start(self) -> None:
        if not self.addresses:
            raise RuntimeError("no LAN IPv4 address found: is this machine connected to Wi-Fi?")
        self._info = ServiceInfo(
            SERVICE_TYPE,
            f"{self.instance}.{SERVICE_TYPE}",
            addresses=[socket.inet_aton(ip) for ip in self.addresses],
            port=self.port,
            properties={"svs": "1", "contract": "1"},
            server=HOSTNAME if self.instance == INSTANCE else f"{self.instance}.local.",
        )
        self._zc = AsyncZeroconf(ip_version=IPVersion.V4Only)
        await self._zc.async_register_service(self._info, allow_name_change=True)

    async def stop(self) -> None:
        if self._zc is not None:
            if self._info is not None:
                await self._zc.async_unregister_service(self._info)
            await self._zc.async_close()
            self._zc = None


@dataclass(frozen=True)
class FoundBroker:
    name: str
    host: str
    port: int


async def discover_brokers(timeout: float = 3.0) -> list[FoundBroker]:
    """Find SVS brokers advertised on the LAN (what the hub firmware does at boot)."""
    zc = AsyncZeroconf(ip_version=IPVersion.V4Only)
    names: set[str] = set()

    def on_change(zeroconf, service_type, name, state_change) -> None:
        if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
            names.add(name)

    browser = AsyncServiceBrowser(zc.zeroconf, [SERVICE_TYPE], handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        found: list[FoundBroker] = []
        for name in sorted(names):
            info = AsyncServiceInfo(SERVICE_TYPE, name)
            if not await info.async_request(zc.zeroconf, 2000):
                continue
            props = {k.decode(): (v or b"").decode() for k, v in info.properties.items()}
            if props.get("svs") != "1":
                continue  # some other MQTT broker on the network
            for ip in info.parsed_addresses(IPVersion.V4Only):
                found.append(FoundBroker(name=name, host=ip, port=info.port))
        return found
    finally:
        await browser.async_cancel()
        await zc.async_close()
