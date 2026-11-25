from datetime import datetime, timezone
from svs.config import get_settings
from svs.db import make_engine, make_sessionmaker
from svs.models import Athlete, AthleteGroup, Consent, ConsentType, Laterality, Organisation
from sqlalchemy import select

sm = make_sessionmaker(make_engine(get_settings().resolved_database_url()))
with sm() as db:
    org = db.scalars(select(Organisation)).first()
    if not org:
        org = Organisation(name="Demo Academy")
        db.add(org)
        db.flush()

    existing = db.scalars(select(Athlete).where(Athlete.org_id == org.id)).all()
    if not existing:
        athletes_data = [
            {
                "code": "ATH-0001",
                "display_name": "Rohan Sharma",
                "birth_year": 2002,
                "group": AthleteGroup.athlete,
                "sport": "Cricket",
                "position": "Wicketkeeper / Batsman",
                "dominant_hand": Laterality.right,
                "dominant_foot": Laterality.right,
                "goals": "Improve peripheral reaction time and hand-eye coordination under pressure.",
            },
            {
                "code": "ATH-0002",
                "display_name": "Ananya Patel",
                "birth_year": 2004,
                "group": AthleteGroup.athlete,
                "sport": "Badminton",
                "position": "Singles",
                "dominant_hand": Laterality.right,
                "dominant_foot": Laterality.left,
                "goals": "Train split-second reaction speed and lateral balance recovery.",
            },
            {
                "code": "ATH-0003",
                "display_name": "Vikram Malhotra",
                "birth_year": 1968,
                "group": AthleteGroup.elderly,
                "sport": "Tennis",
                "position": "Recreational",
                "dominant_hand": Laterality.right,
                "dominant_foot": Laterality.right,
                "goals": "Balance stabilization, fall prevention and reaction maintenance.",
            },
        ]
        now = datetime.now(timezone.utc)
        for d in athletes_data:
            a = Athlete(org_id=org.id, **d)
            db.add(a)
            db.flush()
            for c_type in (ConsentType.data, ConsentType.video, ConsentType.research):
                c = Consent(
                    athlete_id=a.id,
                    type=c_type,
                    text_version="1.0",
                    signed_by=a.display_name or a.code,
                    signed_at=now,
                )
                db.add(c)
        db.commit()
        print(f"Added {len(athletes_data)} sample athletes with active consents.")
    else:
        print(f"Found {len(existing)} existing athletes.")
