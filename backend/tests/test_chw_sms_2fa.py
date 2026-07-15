"""CHW SMS 2FA with trusted devices (SMS Output Spec 2, PR-A).

Every Security invariant in docs/specs/2026-07-15-chw-sms-2fa-design.md is
exercised here:

* No access/refresh token is issued from /auth/login when a challenge is due.
* The pending token authorizes ONLY the two /auth/2fa/* endpoints (type claim
  ``user_2fa_pending``); an admin_2fa token — and a real access token — are
  rejected, and vice versa.
* Device tokens are hash-only at rest; forged/expired/other-user tokens don't
  bypass; remember_device: false stores nothing.
* OTP machinery (attempt caps, TTL, argon2 hashing, sentinel) is reused.
* Admin reset requires the admin TOTP header and writes an audit row.
* Members: sentinel-phone / unverified members can never enable or be
  challenged; the chw_sms_2fa_enabled flag off restores today's login for all.
"""

import os
import re
import uuid
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from httpx import AsyncClient
from jose import jwt

from app.config import settings
from app.models.trusted_device import TrustedDevice
from app.models.user import User
from app.services import user_2fa
from tests.conftest import auth_header
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-for-pytest-1234")
_PASSWORD = "Testpass123!"


# ─── helpers ──────────────────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, email: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": _PASSWORD, "name": "CHW Person", "role": "chw"},
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _register_member(client: AsyncClient, email: str, phone: str | None) -> dict:
    body = {
        "email": email,
        "password": _PASSWORD,
        "name": "Member Person",
        "role": "member",
        "date_of_birth": "1990-01-01",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }
    if phone is not None:
        body["phone"] = phone
    res = await client.post("/api/v1/auth/register", json=body)
    assert res.status_code == 201, res.text
    return res.json()


async def _login(client: AsyncClient, email: str, device_token: str | None = None) -> "tuple":
    headers = {"X-Device-Token": device_token} if device_token else {}
    res = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": _PASSWORD},
        headers=headers,
    )
    return res


def _sub(tokens: dict) -> uuid.UUID:
    import base64
    import json

    seg = tokens["access_token"].split(".")[1]
    seg += "=" * (4 - len(seg) % 4)
    return uuid.UUID(json.loads(base64.urlsafe_b64decode(seg))["sub"])


async def _set_user(user_id: uuid.UUID, **fields) -> None:
    async with _session_factory() as db:
        user = await db.get(User, user_id)
        assert user is not None
        for key, value in fields.items():
            setattr(user, key, value)
        await db.commit()


class _SmsCapture:
    """Capture outbound SMS bodies by patching the Messages client."""

    def __init__(self) -> None:
        self.bodies: list[str] = []

    def latest_code(self) -> str:
        match = re.search(r"\b(\d{6})\b", self.bodies[-1])
        assert match, f"no 6-digit code in {self.bodies[-1]!r}"
        return match.group(1)


def _patch_sms(mp, capture: _SmsCapture, *, success: bool = True):
    from app.services.vonage_sms import SmsSendResult

    async def fake_send_text(self, to_e164, text):
        capture.bodies.append(text)
        if success:
            return SmsSendResult(success=True, provider_message_id="mid-2fa")
        return SmsSendResult(success=False, error="vonage_500", status_code=500)

    mp.setattr(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    )


async def _admin_2fa_headers(client: AsyncClient) -> dict:
    setup = await client.post(
        "/api/v1/admin/2fa/setup", headers={"Authorization": f"Bearer {ADMIN_KEY}"}
    )
    assert setup.status_code == 200, setup.text
    code = pyotp.TOTP(setup.json()["secret"]).now()
    verify = await client.post(
        "/api/v1/admin/2fa/verify",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
        json={"token": code},
    )
    assert verify.status_code == 200, verify.text
    return {
        "Authorization": f"Bearer {ADMIN_KEY}",
        "X-Admin-2FA-Token": verify.json()["two_fa_token"],
    }


# ─── Task 2: pending-token service ────────────────────────────────────────────


async def test_pending_token_roundtrip_returns_user_id():
    uid = uuid.uuid4()
    token = user_2fa.issue_pending_token(uid)
    assert user_2fa.decode_pending_token(token) == uid


async def test_pending_token_bad_signature_rejected():
    uid = uuid.uuid4()
    forged = jwt.encode(
        {"sub": str(uid), "type": user_2fa.PENDING_TOKEN_TYPE,
         "exp": datetime.now(UTC) + timedelta(minutes=5)},
        "the-wrong-signing-secret-entirely",
        algorithm="HS256",
    )
    with pytest.raises(Exception) as exc:
        user_2fa.decode_pending_token(forged)
    assert exc.value.status_code == 401


async def test_pending_token_expired_rejected():
    uid = uuid.uuid4()
    expired = jwt.encode(
        {"sub": str(uid), "type": user_2fa.PENDING_TOKEN_TYPE,
         "exp": datetime.now(UTC) - timedelta(minutes=1)},
        settings.admin_2fa_secret or settings.secret_key,
        algorithm="HS256",
    )
    with pytest.raises(Exception) as exc:
        user_2fa.decode_pending_token(expired)
    assert exc.value.status_code == 401


async def test_admin_2fa_typed_token_rejected_by_user_decode():
    """An admin_2fa token (same signing key) must NOT authorize user 2FA."""
    from app.routers.admin import _issue_2fa_token

    admin_token = _issue_2fa_token()
    with pytest.raises(Exception) as exc:
        user_2fa.decode_pending_token(admin_token)
    assert exc.value.status_code == 401


async def test_user_pending_token_rejected_by_admin_require_2fa():
    """The reverse direction: a user pending token must NOT pass admin 2FA."""
    from app.routers.admin import require_2fa_token

    pending = user_2fa.issue_pending_token(uuid.uuid4())
    with pytest.raises(Exception) as exc:
        await require_2fa_token(x_admin_2fa_token=pending)
    assert exc.value.status_code == 401


async def test_hash_device_token_is_sha256():
    import hashlib

    raw = "some-raw-device-token"
    assert user_2fa.hash_device_token(raw) == hashlib.sha256(raw.encode()).hexdigest()


async def test_user_requires_2fa_matrix():
    chw = User(email="a@x.com", role="chw", name="c")
    assert await user_2fa.user_requires_2fa(chw) is True

    member_default = User(email="b@x.com", role="member", name="m", sms_2fa_enabled=False)
    assert await user_2fa.user_requires_2fa(member_default) is False

    member_opted_verified = User(
        email="c@x.com", role="member", name="m",
        sms_2fa_enabled=True, phone="+13105551212", phone_verified_at=datetime.now(UTC),
    )
    assert await user_2fa.user_requires_2fa(member_opted_verified) is True

    member_opted_unverified = User(
        email="d@x.com", role="member", name="m",
        sms_2fa_enabled=True, phone="+13105551212", phone_verified_at=None,
    )
    assert await user_2fa.user_requires_2fa(member_opted_unverified) is False

    member_opted_sentinel = User(
        email="e@x.com", role="member", name="m",
        sms_2fa_enabled=True, phone="+15555555555", phone_verified_at=datetime.now(UTC),
    )
    assert await user_2fa.user_requires_2fa(member_opted_sentinel) is False

    admin = User(email="f@x.com", role="admin", name="a")
    assert await user_2fa.user_requires_2fa(admin) is False


async def test_user_requires_2fa_flag_off_disables_everyone(monkeypatch):
    monkeypatch.setattr(settings, "chw_sms_2fa_enabled", False)
    chw = User(email="a@x.com", role="chw", name="c")
    member = User(
        email="c@x.com", role="member", name="m",
        sms_2fa_enabled=True, phone="+13105551212", phone_verified_at=datetime.now(UTC),
    )
    assert await user_2fa.user_requires_2fa(chw) is False
    assert await user_2fa.user_requires_2fa(member) is False


async def test_find_valid_trusted_device(client, chw_tokens):
    uid = _sub(chw_tokens)
    raw = user_2fa.mint_device_token()
    async with _session_factory() as db:
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token(raw),
            expires_at=datetime.now(UTC) + timedelta(days=30),
        ))
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token("expired-one"),
            expires_at=datetime.now(UTC) - timedelta(days=1),
        ))
        await db.commit()

    async with _session_factory() as db:
        assert await user_2fa.find_valid_trusted_device(db, uid, raw) is not None
        assert await user_2fa.find_valid_trusted_device(db, uid, None) is None
        assert await user_2fa.find_valid_trusted_device(db, uid, "unknown-token") is None
        assert await user_2fa.find_valid_trusted_device(db, uid, "expired-one") is None
        assert await user_2fa.find_valid_trusted_device(db, uuid.uuid4(), raw) is None


# ─── Task 3: login challenge gate ─────────────────────────────────────────────


async def test_chw_login_is_challenged_with_no_tokens(client):
    await _register_chw(client, "chw_challenge@x.com")
    res = await _login(client, "chw_challenge@x.com")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["two_fa_required"] is True
    assert isinstance(body["pending_token"], str) and body["pending_token"]
    assert body["phone_verification_required"] is True  # CHW registered w/o phone
    assert body["phone_last4"] is None
    # SECURITY INVARIANT: no session material leaks in a challenge response.
    assert "access_token" not in body
    assert "refresh_token" not in body


async def test_member_default_not_challenged(client):
    await _register_member(client, "mem_default@x.com", "+13105550111")
    res = await _login(client, "mem_default@x.com")
    assert res.status_code == 200
    assert res.json().get("two_fa_required") is None
    assert "access_token" in res.json()


async def test_opted_in_verified_member_is_challenged(client):
    tokens = await _register_member(client, "mem_opt@x.com", "+13105550122")
    await _set_user(_sub(tokens), sms_2fa_enabled=True, phone_verified_at=datetime.now(UTC))
    res = await _login(client, "mem_opt@x.com")
    assert res.status_code == 200
    body = res.json()
    assert body["two_fa_required"] is True
    assert body["phone_verification_required"] is False
    assert body["phone_last4"] == "0122"


async def test_sentinel_opted_in_member_fails_open(client):
    tokens = await _register_member(client, "mem_sentinel@x.com", "+15555555555")
    await _set_user(_sub(tokens), sms_2fa_enabled=True, phone_verified_at=datetime.now(UTC))
    res = await _login(client, "mem_sentinel@x.com")
    assert res.status_code == 200
    assert "access_token" in res.json()


async def test_unverified_opted_in_member_fails_open(client):
    tokens = await _register_member(client, "mem_unverif@x.com", "+13105550133")
    await _set_user(_sub(tokens), sms_2fa_enabled=True, phone_verified_at=None)
    res = await _login(client, "mem_unverif@x.com")
    assert res.status_code == 200
    assert "access_token" in res.json()


async def test_flag_off_restores_password_login_for_everyone(client, monkeypatch):
    await _register_chw(client, "chw_flagoff@x.com")
    monkeypatch.setattr(settings, "chw_sms_2fa_enabled", False)
    res = await _login(client, "chw_flagoff@x.com")
    assert res.status_code == 200
    assert "access_token" in res.json()


async def test_valid_device_header_bypasses_challenge(client):
    tokens = await _register_chw(client, "chw_device@x.com")
    uid = _sub(tokens)
    raw = user_2fa.mint_device_token()
    async with _session_factory() as db:
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token(raw),
            expires_at=datetime.now(UTC) + timedelta(days=30),
        ))
        await db.commit()

    res = await _login(client, "chw_device@x.com", device_token=raw)
    assert res.status_code == 200
    assert "access_token" in res.json()

    # last_used_at was stamped on the bypass.
    async with _session_factory() as db:
        from sqlalchemy import select
        row = (await db.execute(
            select(TrustedDevice).where(TrustedDevice.user_id == uid)
        )).scalar_one()
        assert (datetime.now(UTC) - row.last_used_at) < timedelta(minutes=1)


async def test_forged_expired_and_other_user_device_do_not_bypass(client):
    tokens = await _register_chw(client, "chw_baddev@x.com")
    uid = _sub(tokens)
    # expired device for this user + a valid device for ANOTHER user
    other = await _register_chw(client, "chw_other@x.com")
    raw_other = user_2fa.mint_device_token()
    async with _session_factory() as db:
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token("mine-expired"),
            expires_at=datetime.now(UTC) - timedelta(days=1),
        ))
        db.add(TrustedDevice(
            user_id=_sub(other), token_hash=user_2fa.hash_device_token(raw_other),
            expires_at=datetime.now(UTC) + timedelta(days=30),
        ))
        await db.commit()

    for header in ("forged-token", "mine-expired", raw_other):
        res = await _login(client, "chw_baddev@x.com", device_token=header)
        assert res.json().get("two_fa_required") is True, header


async def test_admin_login_untouched_by_2fa(client):
    async with _session_factory() as db:
        from app.utils.security import hash_password
        db.add(User(
            email="admin_login@x.com", role="admin", name="Admin",
            password_hash=hash_password(_PASSWORD),
        ))
        await db.commit()
    res = await _login(client, "admin_login@x.com")
    assert res.status_code == 200
    assert "access_token" in res.json()
    assert res.json().get("two_fa_required") is None


# ─── Task 4: send-code + verify ───────────────────────────────────────────────


async def _challenge_and_send(client, capture, email, phone=None, *, success=True):
    login = await _login(client, email)
    pending = login.json()["pending_token"]
    with pytest.MonkeyPatch.context() as mp:
        _patch_sms(mp, capture, success=success)
        body = {"pending_token": pending}
        if phone is not None:
            body["phone"] = phone
        send = await client.post("/api/v1/auth/2fa/send-code", json=body)
    return pending, send


async def test_full_chw_enrollment_happy_path(client):
    await _register_chw(client, "chw_happy@x.com")
    capture = _SmsCapture()
    pending, send = await _challenge_and_send(
        client, capture, "chw_happy@x.com", phone="+13105559001"
    )
    assert send.status_code == 200, send.text
    assert send.json() == {"sent": True, "phone_last4": "9001"}

    code = capture.latest_code()
    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": pending, "code": code, "remember_device": False},
    )
    assert verify.status_code == 200, verify.text
    data = verify.json()
    assert data["access_token"] and data["refresh_token"]
    assert data["role"] == "chw"
    assert data["device_token"] is None

    # tokens actually work on a protected endpoint
    profile = await client.get("/api/v1/chw/profile", headers=auth_header(data))
    assert profile.status_code == 200

    # enrollment persisted the verified phone
    async with _session_factory() as db:
        from sqlalchemy import select
        user = (await db.execute(
            select(User).where(User.email == "chw_happy@x.com")
        )).scalar_one()
        assert user.phone == "+13105559001"
        assert user.phone_verified_at is not None


async def test_verified_member_relogin_sends_to_verified_phone(client):
    tokens = await _register_member(client, "mem_reuse@x.com", "+13105550155")
    await _set_user(_sub(tokens), sms_2fa_enabled=True, phone_verified_at=datetime.now(UTC))
    capture = _SmsCapture()
    # phone param supplied but must be IGNORED — code goes to the verified number
    pending, send = await _challenge_and_send(
        client, capture, "mem_reuse@x.com", phone="+13109990000"
    )
    assert send.status_code == 200
    assert send.json()["phone_last4"] == "0155"


async def test_wrong_code_422_decrements_then_exhausts_410(client):
    await _register_chw(client, "chw_wrong@x.com")
    capture = _SmsCapture()
    pending, send = await _challenge_and_send(
        client, capture, "chw_wrong@x.com", phone="+13105559010"
    )
    assert send.status_code == 200

    # 5 wrong attempts: first 4 → 422 with decremented count, 5th → 410 exhausted
    for expected_remaining in (4, 3, 2, 1):
        res = await client.post(
            "/api/v1/auth/2fa/verify",
            json={"pending_token": pending, "code": "000000", "remember_device": False},
        )
        assert res.status_code == 422, res.text
        assert f"{expected_remaining} attempt" in res.json()["detail"]

    exhausted = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": pending, "code": "000000", "remember_device": False},
    )
    assert exhausted.status_code == 410, exhausted.text


async def test_expired_pending_token_rejected_by_2fa_endpoints(client):
    await _register_chw(client, "chw_exp@x.com")
    uid_login = await _login(client, "chw_exp@x.com")
    # forge an expired pending token for the same user
    sub = user_2fa.decode_pending_token(uid_login.json()["pending_token"])
    expired = jwt.encode(
        {"sub": str(sub), "type": user_2fa.PENDING_TOKEN_TYPE,
         "exp": datetime.now(UTC) - timedelta(minutes=1)},
        settings.admin_2fa_secret or settings.secret_key, algorithm="HS256",
    )
    send = await client.post(
        "/api/v1/auth/2fa/send-code", json={"pending_token": expired, "phone": "+13105559011"}
    )
    assert send.status_code == 401
    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": expired, "code": "123456", "remember_device": False},
    )
    assert verify.status_code == 401


async def test_pending_token_rejected_by_other_endpoints(client):
    await _register_chw(client, "chw_scope@x.com")
    pending = (await _login(client, "chw_scope@x.com")).json()["pending_token"]
    # A pending token is NOT an access token — protected endpoints reject it.
    hdr = {"Authorization": f"Bearer {pending}"}
    assert (await client.get("/api/v1/chw/members", headers=hdr)).status_code == 401
    assert (await client.get("/api/v1/member/profile", headers=hdr)).status_code == 401


async def test_real_access_token_rejected_by_2fa_endpoints(client, chw_tokens):
    # A real access token must NOT authorize the 2FA endpoints in a pending
    # token's place (wrong type claim).
    send = await client.post(
        "/api/v1/auth/2fa/send-code",
        json={"pending_token": chw_tokens["access_token"], "phone": "+13105559012"},
    )
    assert send.status_code == 401
    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": chw_tokens["access_token"], "code": "123456",
              "remember_device": False},
    )
    assert verify.status_code == 401


async def test_send_code_sentinel_and_missing_and_duplicate(client):
    await _register_chw(client, "chw_edge@x.com")
    # taken phone on another account for the 409 case
    await _register_member(client, "holder@x.com", "+13105559099")

    capture = _SmsCapture()

    # missing phone (enrollment) → 422
    _, missing = await _challenge_and_send(client, capture, "chw_edge@x.com", phone=None)
    assert missing.status_code == 422

    # sentinel phone → 422
    _, sentinel = await _challenge_and_send(client, capture, "chw_edge@x.com", phone="+15555555555")
    assert sentinel.status_code == 422

    # duplicate phone → 409
    _, dup = await _challenge_and_send(client, capture, "chw_edge@x.com", phone="+13105559099")
    assert dup.status_code == 409


async def test_send_code_delivery_failure_returns_500(client):
    await _register_chw(client, "chw_fail@x.com")
    capture = _SmsCapture()
    _, send = await _challenge_and_send(
        client, capture, "chw_fail@x.com", phone="+13105559013", success=False
    )
    assert send.status_code == 500


async def test_send_code_rate_limited_after_three_starts(client):
    await _register_chw(client, "chw_rl@x.com")
    capture = _SmsCapture()
    pending = (await _login(client, "chw_rl@x.com")).json()["pending_token"]
    with pytest.MonkeyPatch.context() as mp:
        _patch_sms(mp, capture)
        for _ in range(3):
            ok = await client.post(
                "/api/v1/auth/2fa/send-code",
                json={"pending_token": pending, "phone": "+13105559014"},
            )
            assert ok.status_code == 200
        limited = await client.post(
            "/api/v1/auth/2fa/send-code",
            json={"pending_token": pending, "phone": "+13105559014"},
        )
    assert limited.status_code == 429


async def test_remember_device_stores_hash_only_and_next_login_bypasses(client):
    await _register_chw(client, "chw_remember@x.com")
    capture = _SmsCapture()
    pending, send = await _challenge_and_send(
        client, capture, "chw_remember@x.com", phone="+13105559015"
    )
    code = capture.latest_code()
    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": pending, "code": code, "remember_device": True},
    )
    assert verify.status_code == 200
    raw_device = verify.json()["device_token"]
    assert raw_device

    # hash-only at rest: the raw token is nowhere in trusted_devices.
    async with _session_factory() as db:
        from sqlalchemy import select
        rows = (await db.execute(select(TrustedDevice))).scalars().all()
        assert len(rows) == 1
        assert rows[0].token_hash == user_2fa.hash_device_token(raw_device)
        assert rows[0].token_hash != raw_device
        assert rows[0].user_agent is None or isinstance(rows[0].user_agent, str)

    # next login WITH the device token bypasses the challenge.
    bypass = await _login(client, "chw_remember@x.com", device_token=raw_device)
    assert bypass.status_code == 200
    assert "access_token" in bypass.json()


async def test_remember_device_false_stores_nothing(client):
    await _register_chw(client, "chw_noremember@x.com")
    capture = _SmsCapture()
    pending, _ = await _challenge_and_send(
        client, capture, "chw_noremember@x.com", phone="+13105559016"
    )
    code = capture.latest_code()
    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": pending, "code": code, "remember_device": False},
    )
    assert verify.status_code == 200
    async with _session_factory() as db:
        from sqlalchemy import select
        rows = (await db.execute(select(TrustedDevice))).scalars().all()
        assert rows == []


async def test_verify_enrollment_duplicate_phone_returns_409(client):
    """Two CHWs enrolling the same number: the second verify → clean 409."""
    await _register_member(client, "phone_holder@x.com", "+13105559200")
    await _register_chw(client, "chw_dupverify@x.com")
    capture = _SmsCapture()

    # send-code to a fresh number that is NOT yet taken passes the pre-check,
    # then we make it collide by seeding the holder AFTER send — simplest is to
    # target an already-held number but the send-code pre-check would 409 first.
    # Instead: enroll toward a number, then race a second account onto it.
    pending, send = await _challenge_and_send(
        client, capture, "chw_dupverify@x.com", phone="+13105559201"
    )
    assert send.status_code == 200
    code = capture.latest_code()
    # seed another user holding +13105559201 to force the verify-time collision
    async with _session_factory() as db:
        db.add(User(
            email="racer@x.com", role="member", name="R",
            phone="+13105559201",
        ))
        await db.commit()

    verify = await client.post(
        "/api/v1/auth/2fa/verify",
        json={"pending_token": pending, "code": code, "remember_device": False},
    )
    assert verify.status_code == 409, verify.text


# ─── Task 5: admin reset + logout-everywhere revocation + member PATCH ─────────


async def test_admin_reset_requires_totp(client):
    tokens = await _register_chw(client, "chw_reset_auth@x.com")
    uid = _sub(tokens)
    # admin key alone (no X-Admin-2FA-Token) is insufficient
    res = await client.post(
        f"/api/v1/admin/chws/{uid}/reset-2fa",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
    )
    assert res.status_code == 401


async def test_admin_reset_member_target_404(client):
    tokens = await _register_member(client, "mem_reset_target@x.com", "+13105559300")
    headers = await _admin_2fa_headers(client)
    res = await client.post(
        f"/api/v1/admin/chws/{_sub(tokens)}/reset-2fa", headers=headers
    )
    assert res.status_code == 404


async def test_admin_reset_full_effect_and_audit(client):
    tokens = await _register_chw(client, "chw_reset_full@x.com")
    uid = _sub(tokens)
    # seed verified phone + a trusted device + verify a live refresh token
    raw_device = user_2fa.mint_device_token()
    await _set_user(uid, phone="+13105559301", phone_verified_at=datetime.now(UTC))
    async with _session_factory() as db:
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token(raw_device),
            expires_at=datetime.now(UTC) + timedelta(days=30),
        ))
        await db.commit()

    headers = await _admin_2fa_headers(client)
    res = await client.post(f"/api/v1/admin/chws/{uid}/reset-2fa", headers=headers)
    assert res.status_code == 200, res.text
    assert res.json() == {"reset": True}

    async with _session_factory() as db:
        from sqlalchemy import select

        from app.models.audit import AuditLog

        user = await db.get(User, uid)
        assert user.phone is None
        assert user.phone_verified_at is None
        devices = (await db.execute(
            select(TrustedDevice).where(TrustedDevice.user_id == uid)
        )).scalars().all()
        assert devices == []
        audit = (await db.execute(
            select(AuditLog).where(AuditLog.action == "chw_2fa_reset")
        )).scalars().all()
        assert len(audit) == 1
        assert audit[0].resource_id == str(uid)

    # post-reset login → phone_verification_required True (must re-enroll)
    login = await _login(client, "chw_reset_full@x.com")
    assert login.json()["two_fa_required"] is True
    assert login.json()["phone_verification_required"] is True


async def test_logout_everywhere_deletes_trusted_devices(client):
    """A password reset (logout-everywhere) clears trusted devices."""
    tokens = await _register_member(client, "mem_logout@x.com", "+13105559400")
    uid = _sub(tokens)
    async with _session_factory() as db:
        db.add(TrustedDevice(
            user_id=uid, token_hash=user_2fa.hash_device_token("dev-a"),
            expires_at=datetime.now(UTC) + timedelta(days=30),
        ))
        await db.commit()

    from app.services.auth_service import revoke_all_refresh_tokens_for_user

    async with _session_factory() as db:
        await revoke_all_refresh_tokens_for_user(db, uid)
        await db.commit()

    async with _session_factory() as db:
        from sqlalchemy import select
        rows = (await db.execute(
            select(TrustedDevice).where(TrustedDevice.user_id == uid)
        )).scalars().all()
        assert rows == []


async def test_member_sms_2fa_toggle_requires_verified_phone(client):
    """The FE toggle PUTs ``sms_2fa_enabled`` on /member/profile (plan Task 9
    note): enable is guarded by verified-phone, disable always allowed, and the
    state round-trips on the profile response."""
    tokens = await _register_member(client, "mem_toggle@x.com", "+13105559500")
    # unverified → enabling is rejected 422
    res = await client.put(
        "/api/v1/member/profile", json={"sms_2fa_enabled": True},
        headers=auth_header(tokens),
    )
    assert res.status_code == 422

    # verify the phone, then enabling works
    await _set_user(_sub(tokens), phone_verified_at=datetime.now(UTC))
    ok = await client.put(
        "/api/v1/member/profile", json={"sms_2fa_enabled": True},
        headers=auth_header(tokens),
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["sms_2fa_enabled"] is True

    # it is surfaced on the profile + drives the login challenge
    profile = await client.get("/api/v1/member/profile", headers=auth_header(tokens))
    assert profile.json()["sms_2fa_enabled"] is True
    login = await _login(client, "mem_toggle@x.com")
    assert login.json()["two_fa_required"] is True

    # an unrelated profile edit (field omitted) must NOT clobber the opt-in
    unrelated = await client.put(
        "/api/v1/member/profile", json={"city": "Los Angeles"},
        headers=auth_header(tokens),
    )
    assert unrelated.status_code == 200
    assert unrelated.json()["sms_2fa_enabled"] is True

    # disabling is always allowed
    off = await client.put(
        "/api/v1/member/profile", json={"sms_2fa_enabled": False},
        headers=auth_header(tokens),
    )
    assert off.status_code == 200
    assert off.json()["sms_2fa_enabled"] is False


async def test_member_sentinel_phone_cannot_enable_2fa(client):
    """A sentinel-phone member can never enable 2FA even if 'verified'."""
    tokens = await _register_member(client, "mem_sent_toggle@x.com", "+15555555555")
    await _set_user(_sub(tokens), phone_verified_at=datetime.now(UTC))
    res = await client.put(
        "/api/v1/member/profile", json={"sms_2fa_enabled": True},
        headers=auth_header(tokens),
    )
    assert res.status_code == 422
