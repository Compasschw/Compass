"""add member_profiles.medi_cal_id_hash — deterministic CIN uniqueness digest

QA feedback batch (2026-07-14), Part 4 — CIN (Medi-Cal ID) uniqueness across
members. ``member_profiles.medi_cal_id`` is encrypted at rest with
AES-256-GCM using a RANDOM NONCE PER ROW (``app.utils.encryption.
EncryptedString``), so identical plaintext CINs produce different
ciphertext — neither a raw column comparison nor a unique index on the
encrypted column can ever detect a duplicate. This migration adds a
deterministic HMAC-SHA256 digest column instead: the same normalized CIN
always hashes to the same value (keyed off the app's PHI_ENCRYPTION_KEY, see
``app.utils.encryption.hash_cin`` — HMAC, not a plain hash, so a leaked DB
dump can't be brute-forced against the small CIN keyspace), so a partial
unique index on the digest enforces "no two members share a CIN" without
ever storing or indexing the plaintext CIN itself.

Steps:
  1. Add ``member_profiles.medi_cal_id_hash`` (nullable — mirrors
     ``medi_cal_id``'s optionality; only members who supplied a CIN get a
     hash).
  2. Backfill: decrypt every existing non-null ``medi_cal_id`` (via the same
     ``EncryptedString`` codec the app uses) and normalize it (via the same
     ``normalize_cin`` the app uses), then write its HMAC-SHA256 digest.
  3. Fail loud if the backfill discovers pre-existing duplicate CINs — same
     philosophy as ``chwphone0713``'s original fail-loud duplicate check:
     list the MASKED offending CINs and raise, rather than silently picking
     a "winner" (which member keeps the CIN is a founders decision, not
     this migration's). Prod is KNOWN to have at least one QA-created
     duplicate today (e.g. "12345678A") — this migration is EXPECTED to
     fail loud on its first run against prod. Resolve manually (edit or
     clear the CIN on all but one of the colliding member profiles via the
     app, per the same runbook used for the phone dedup) and re-run.
  4. Create partial unique index ``uq_member_profiles_cin_hash`` WHERE
     ``medi_cal_id_hash IS NOT NULL``.

Application-layer enforcement
(``app.services.auth_service.check_cin_uniqueness``) already rejects a
duplicate CIN with a clean 409 before this index would ever be hit in the
common (non-racing) case — this index is the race-safe backstop, mirroring
the phone-uniqueness pattern established by ``chwphone0713``.

Revision ID: cinhash0715
Revises: phoneidx0715
"""

from collections import defaultdict

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "cinhash0715"
down_revision: str | None = "phoneidx0715"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_member_profiles_cin_hash"


def upgrade() -> None:
    # Imported lazily (inside the function, not at module scope) so that
    # merely SCANNING the versions/ directory to build Alembic's revision
    # graph never imports app.* — these imports only execute when this
    # specific migration actually runs.
    from app.schemas.cin_config import normalize_cin
    from app.utils.encryption import EncryptedString, hash_cin

    connection = op.get_bind()

    op.add_column(
        "member_profiles",
        sa.Column("medi_cal_id_hash", sa.String(64), nullable=True),
    )

    codec = EncryptedString()
    rows = connection.execute(
        text("SELECT id, medi_cal_id FROM member_profiles WHERE medi_cal_id IS NOT NULL")
    ).fetchall()

    # digest -> [(member_profile_id, normalized_cin), ...]
    hash_to_entries: dict[str, list[tuple[object, str]]] = defaultdict(list)
    id_to_hash: dict[object, str] = {}
    for row in rows:
        plaintext = codec.process_result_value(row.medi_cal_id, dialect=None)
        if not plaintext:
            continue
        normalized = normalize_cin(plaintext)
        if not normalized:
            continue
        digest = hash_cin(normalized)
        hash_to_entries[digest].append((row.id, normalized))
        id_to_hash[row.id] = digest

    duplicates = {h: entries for h, entries in hash_to_entries.items() if len(entries) > 1}
    if duplicates:
        # Mask the CIN for the error message — first 2 + last 2 characters
        # only, matching the masking convention used elsewhere for PHI in
        # logs (see routers/auth.py's phone-masking / CIN-masking on the
        # 409 handlers this migration's sibling application-layer check
        # feeds).
        groups = []
        for entries in duplicates.values():
            masked = [
                f"{cin[:2]}***{cin[-2:]} (member_profile={pid})" for pid, cin in entries
            ]
            groups.append(", ".join(masked))
        raise RuntimeError(
            "Cannot add unique index on member_profiles.medi_cal_id_hash — "
            "duplicate CINs already exist across members: "
            + " | ".join(groups)
            + ". Resolve these manually (decide which member keeps the CIN; "
            "correct or clear the CIN on the others via the app's profile-"
            "edit endpoints) before re-running this migration."
        )

    for member_profile_id, digest in id_to_hash.items():
        connection.execute(
            text(
                "UPDATE member_profiles SET medi_cal_id_hash = :digest WHERE id = :id"
            ),
            {"digest": digest, "id": member_profile_id},
        )

    op.create_index(
        _INDEX_NAME,
        "member_profiles",
        ["medi_cal_id_hash"],
        unique=True,
        postgresql_where=text("medi_cal_id_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="member_profiles")
    op.drop_column("member_profiles", "medi_cal_id_hash")
