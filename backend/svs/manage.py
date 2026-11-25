"""Admin CLI.

    python -m svs.manage init-db                       # apply migrations (creates data/svs.db)
    python -m svs.manage create-admin --org "Demo Academy" --email admin@example.com
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from .config import get_settings
from .db import make_engine, make_sessionmaker
from .models import Organisation, Role, User
from .security import hash_password

BACKEND_DIR = Path(__file__).resolve().parent.parent


def alembic_config(database_url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


def init_db() -> None:
    url = get_settings().resolved_database_url()
    command.upgrade(alembic_config(url), "head")
    print(f"database ready: {url}")


def create_admin(org_name: str, email: str, full_name: str, password: str | None) -> None:
    password = password or getpass.getpass("Password (min 8 chars): ")
    if len(password) < 8:
        sys.exit("password must be at least 8 characters")
    sm = make_sessionmaker(make_engine(get_settings().resolved_database_url()))
    with sm() as db:
        org = db.scalars(select(Organisation).where(Organisation.name == org_name)).first()
        if org is None:
            org = Organisation(name=org_name)
            db.add(org)
            db.flush()
        if db.scalars(select(User).where(User.email == email.lower())).first():
            sys.exit(f"user {email} already exists")
        db.add(User(org_id=org.id, email=email.lower(), full_name=full_name, role=Role.admin,
                    password_hash=hash_password(password)))
        db.commit()
    print(f"admin {email} created in organisation '{org_name}'")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m svs.manage")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db", help="apply database migrations")
    ca = sub.add_parser("create-admin", help="create an organisation admin")
    ca.add_argument("--org", required=True)
    ca.add_argument("--email", required=True)
    ca.add_argument("--name", default="Administrator")
    ca.add_argument("--password", help="omit to be prompted")
    a = p.parse_args()
    if a.cmd == "init-db":
        init_db()
    elif a.cmd == "create-admin":
        create_admin(a.org, a.email, a.name, a.password)


if __name__ == "__main__":
    main()
