"""Email provider factory + template helpers.

Templates live here so they can be swapped for Mustache / Jinja / MJML later
without touching the provider adapter.
"""

from app.services.email.base import EmailMessage, EmailProvider, EmailResult

_provider_instance: EmailProvider | None = None


def get_email_provider() -> EmailProvider:
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "email_provider", "ses")

    if provider_name == "ses":
        from app.services.email.ses_provider import SESEmailProvider
        _provider_instance = SESEmailProvider(
            region=getattr(settings, "aws_region", "us-west-2"),
            from_address=getattr(settings, "email_from", "noreply@joincompasschw.com"),
            reply_to=getattr(settings, "email_reply_to", None) or None,
        )
    elif provider_name == "noop":
        # Test/CI-only — see NoopEmailProvider's docstring.
        from app.services.email.base import NoopEmailProvider
        _provider_instance = NoopEmailProvider()
    else:
        raise ValueError(f"Unknown email provider: {provider_name}")

    return _provider_instance


def render_magic_link_email(magic_url: str, ttl_minutes: int = 15) -> tuple[str, str, str]:
    """Render subject, HTML body, text body for a magic-link email."""
    subject = "Your CompassCHW sign-in link"

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        Sign in to CompassCHW
      </h2>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 24px 0;">
        Tap the button below to sign in. This link expires in {ttl_minutes} minutes and can only be used once.
      </p>
      <a href="{magic_url}"
         style="display:inline-block;background:#3D5A3E;color:white;text-decoration:none;
                padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">
        Sign in to CompassCHW
      </a>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        If you didn't request this email, you can safely ignore it.
      </p>
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = f"""Sign in to CompassCHW

Open this link to sign in:

{magic_url}

This link expires in {ttl_minutes} minutes and can only be used once.

If you didn't request this email, you can safely ignore it.

— CompassCHW"""

    return subject, html, text


async def send_magic_link_email(to: str, magic_url: str, ttl_minutes: int = 15) -> EmailResult:
    """Send a magic-link sign-in email. Returns a result; never raises."""
    subject, html, text = render_magic_link_email(magic_url, ttl_minutes)
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "magic_link"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("Magic link email failed: %s", e)
        return EmailResult(success=False, error=str(e))


def render_request_accepted_email(
    member_first_name: str,
    chw_first_name: str,
    vertical: str,
    scheduled_at_iso: str,
) -> tuple[str, str, str]:
    """Render the "your CHW accepted your request" notification email."""
    pretty_vertical = vertical.replace("_", " ").title()
    subject = f"{chw_first_name} accepted your request"

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        Hi {member_first_name},
      </h2>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        Good news — <strong>{chw_first_name}</strong> just accepted your request for help with
        <strong>{pretty_vertical}</strong>.
      </p>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        We've added the session to your calendar. {chw_first_name} will reach out
        shortly to confirm the time and start working with you.
      </p>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        Reply to this email or open the CompassCHW app if you need to make changes.
      </p>
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = f"""Hi {member_first_name},

Good news — {chw_first_name} just accepted your request for help with {pretty_vertical}.

We've added the session to your calendar. {chw_first_name} will reach out shortly
to confirm the time and start working with you.

Reply to this email or open the CompassCHW app if you need to make changes.

— CompassCHW"""

    return subject, html, text


async def send_request_accepted_email(
    to: str,
    member_first_name: str,
    chw_first_name: str,
    vertical: str,
    scheduled_at_iso: str,
) -> EmailResult:
    """Notify a member that their request was accepted by a CHW.

    Best-effort: errors are logged and returned, never raised, so a transient
    SES blip doesn't fail the accept endpoint.
    """
    subject, html, text = render_request_accepted_email(
        member_first_name, chw_first_name, vertical, scheduled_at_iso
    )
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "request_accepted"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("Request-accepted email failed: %s", e)
        return EmailResult(success=False, error=str(e))


def render_signup_confirmation_email(
    name: str, *, created_by_chw: bool = False, role: str = "member",
) -> tuple[str, str, str]:
    """Render subject, HTML body, text body for the post-signup "welcome"
    confirmation email.

    Three copy variants (Epic A v2), selected by ``role`` / ``created_by_chw``:

    1. **Self-signup member** (``role="member"``, ``created_by_chw=False``):
       welcome + "what happens next" bullets (find your CHW, schedule your
       first session) + app link + support contact. No PHI.
    2. **CHW-created member** (``role="member"``, ``created_by_chw=True``):
       same welcome shape, plus a note that their Community Health Worker
       created the account and they'll set their own password at first
       sign-in (mirrors ``User.must_change_password``). Still no PHI — no
       CHW name, no health information, just the fact of CHW-assisted
       creation.
    3. **CHW account signup** (``role != "member"``): simple welcome copy,
       unchanged from the v1 generic template — CHWs don't need the
       member-facing "what happens next" bullets.

    ``name`` is the account holder's display name; falls back gracefully to
    a neutral greeting if empty. Preserves the existing inline-CSS
    brand-card visual pattern used by ``send_magic_link_email`` /
    the v1 template so all transactional emails look consistent.
    """
    greeting_name = (name or "").strip() or "there"
    subject = "Welcome to CompassCHW"

    if role != "member":
        # Variant 3 — CHW (or any non-member) account: simple welcome copy.
        body_html = """
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        Thanks for signing up for CompassCHW — your account has been created
        successfully.
      </p>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        You can open the app any time to pick up where you left off.
      </p>"""
        body_text = (
            "Thanks for signing up for CompassCHW — your account has been "
            "created successfully.\n\n"
            "You can open the app any time to pick up where you left off."
        )
    else:
        # Variants 1 & 2 — member account: welcome + "what happens next".
        next_steps_html = """
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 8px 0;">
        Here's what happens next:
      </p>
      <ul style="color:#555;font-size:15px;line-height:1.6;margin:0 0 16px 0;padding-left:20px;">
        <li>Find your Community Health Worker</li>
        <li>Schedule your first session</li>
      </ul>
      <p style="margin:24px 0;">
        <a href="https://joincompasschw.com"
           style="display:inline-block;background:#3D5A3E;color:white;text-decoration:none;
                  padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">
          Open CompassCHW
        </a>
      </p>"""
        next_steps_text = (
            "Here's what happens next:\n"
            "  - Find your Community Health Worker\n"
            "  - Schedule your first session\n\n"
            "Open the app: https://joincompasschw.com"
        )

        if created_by_chw:
            intro_html = """
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        Welcome to CompassCHW — your Community Health Worker created your
        account to get you started.
      </p>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        At your first sign-in, you'll be asked to set your own password.
      </p>"""
            intro_text = (
                "Welcome to CompassCHW — your Community Health Worker created "
                "your account to get you started.\n\n"
                "At your first sign-in, you'll be asked to set your own password."
            )
        else:
            intro_html = """
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        Welcome to CompassCHW — your account has been created successfully.
      </p>"""
            intro_text = "Welcome to CompassCHW — your account has been created successfully."

        body_html = intro_html + next_steps_html
        body_text = intro_text + "\n\n" + next_steps_text

    support_html = """
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        Questions? Reach us any time at
        <a href="mailto:support@joincompasschw.com" style="color:#3D5A3E;">support@joincompasschw.com</a>.
      </p>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:8px 0 0 0;">
        If you didn't create this account, you can safely ignore this email.
      </p>"""
    support_text = (
        "Questions? Reach us any time at support@joincompasschw.com.\n\n"
        "If you didn't create this account, you can safely ignore this email."
    )

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        Hi {greeting_name},
      </h2>{body_html}{support_html}
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = f"""Hi {greeting_name},

{body_text}

{support_text}

— CompassCHW"""

    return subject, html, text


async def send_signup_confirmation_email(
    to: str, name: str, *, created_by_chw: bool = False, role: str = "member",
) -> EmailResult:
    """Send the post-signup "welcome" confirmation email. Returns a result;
    never raises.

    ``created_by_chw`` and ``role`` select the copy variant — see
    ``render_signup_confirmation_email`` for the three variants. Both
    default to the self-signup-member shape for backwards compatibility
    with existing call sites that don't pass them.

    Best-effort by construction (matches ``send_magic_link_email`` /
    ``send_request_accepted_email``): any exception raised while resolving
    the provider or sending is caught, logged, and folded into a failed
    ``EmailResult`` rather than propagating — so a slow/unavailable SES (or
    a sandbox-mode rejection) never blocks or fails the caller's HTTP
    response. Callers should invoke this via ``BackgroundTasks`` (see
    ``app.services.signup_confirmations``) rather than awaiting it inline on
    the request path.
    """
    subject, html, text = render_signup_confirmation_email(
        name, created_by_chw=created_by_chw, role=role,
    )
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "signup_confirmation"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("Signup confirmation email failed: %s", e)
        return EmailResult(success=False, error=str(e))


def render_password_reset_email(reset_url: str, ttl_minutes: int = 30) -> tuple[str, str, str]:
    """Render subject, HTML body, text body for the forgot-password reset
    email. Mirrors ``render_magic_link_email``'s structure/tone. No PHI."""
    subject = "Reset your CompassCHW password"

    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        Reset your password
      </h2>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 24px 0;">
        We received a request to reset your CompassCHW password. Tap the
        button below to choose a new one. This link expires in {ttl_minutes} minutes
        and can only be used once.
      </p>
      <a href="{reset_url}"
         style="display:inline-block;background:#3D5A3E;color:white;text-decoration:none;
                padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">
        Reset password
      </a>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        If you didn't request this, you can safely ignore this email — your
        password is unchanged.
      </p>
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = f"""Reset your CompassCHW password

We received a request to reset your CompassCHW password. Open this link to
choose a new one:

{reset_url}

This link expires in {ttl_minutes} minutes and can only be used once.

If you didn't request this, you can safely ignore this email — your
password is unchanged.

— CompassCHW"""

    return subject, html, text


async def send_password_reset_email(to: str, reset_url: str, ttl_minutes: int = 30) -> EmailResult:
    """Send the forgot-password reset email. Returns a result; never raises.

    Best-effort by construction, matching ``send_magic_link_email`` — a
    slow/down SES never blocks or fails the request endpoint. Callers should
    still preserve the no-enumeration 202 response regardless of this
    result.
    """
    subject, html, text = render_password_reset_email(reset_url, ttl_minutes)
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "password_reset"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("Password reset email failed: %s", e)
        return EmailResult(success=False, error=str(e))


def render_oauth_only_password_reset_email() -> tuple[str, str, str]:
    """Render the informational email sent when a password reset is
    requested for an OAuth-only account (``password_hash IS NULL``) — there
    is no password to reset, so instead of a reset link we point the user at
    the sign-in-with-Google/Apple button. No PHI."""
    subject = "About your CompassCHW sign-in"

    html = """<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        About your sign-in
      </h2>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        We received a request to reset the password on this CompassCHW
        account. This account signs in with Google or Apple — there's no
        CompassCHW password to reset.
      </p>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        Use the "Sign in with Google" or "Sign in with Apple" button on the
        sign-in page instead.
      </p>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = """About your sign-in

We received a request to reset the password on this CompassCHW account.
This account signs in with Google or Apple — there's no CompassCHW password
to reset.

Use the "Sign in with Google" or "Sign in with Apple" button on the sign-in
page instead.

If you didn't request this, you can safely ignore this email.

— CompassCHW"""

    return subject, html, text


async def send_oauth_only_password_reset_email(to: str) -> EmailResult:
    """Send the OAuth-only informational email. Returns a result; never raises."""
    subject, html, text = render_oauth_only_password_reset_email()
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "password_reset"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("OAuth-only reset email failed: %s", e)
        return EmailResult(success=False, error=str(e))


def render_password_changed_email() -> tuple[str, str, str]:
    """Render the "your password was changed" confirmation email, sent after
    a successful password reset. No PHI."""
    subject = "Your CompassCHW password was changed"

    html = """<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F1ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <h1 style="color:#1E3320;font-size:24px;margin:0 0 8px 0;">
      Compass<span style="color:#7A9F5A;">CHW</span>
    </h1>
    <div style="background:white;border-radius:16px;padding:32px;margin-top:24px;">
      <h2 style="color:#1E3320;font-size:20px;margin:0 0 16px 0;">
        Your password was changed
      </h2>
      <p style="color:#555;font-size:15px;line-height:1.5;margin:0 0 16px 0;">
        This is a confirmation that your CompassCHW password was just
        changed. You've been signed out of all devices for your security —
        sign back in with your new password.
      </p>
      <p style="color:#888;font-size:13px;line-height:1.5;margin:24px 0 0 0;">
        If this wasn't you, contact support@joincompasschw.com immediately.
      </p>
    </div>
    <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;">
      CompassCHW · Community Health Workers, connected.
    </p>
  </div>
</body>
</html>"""

    text = """Your password was changed

This is a confirmation that your CompassCHW password was just changed.
You've been signed out of all devices for your security — sign back in with
your new password.

If this wasn't you, contact support@joincompasschw.com immediately.

— CompassCHW"""

    return subject, html, text


async def send_password_changed_email(to: str) -> EmailResult:
    """Send the "your password was changed" confirmation email. Returns a
    result; never raises — this fires after the reset already succeeded, so
    a delivery failure must never unwind the (already-committed) password
    change."""
    subject, html, text = render_password_changed_email()
    try:
        provider = get_email_provider()
        return await provider.send(EmailMessage(
            to=to,
            subject=subject,
            html=html,
            text=text,
            tags={"category": "password_changed"},
        ))
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass.email").error("Password changed email failed: %s", e)
        return EmailResult(success=False, error=str(e))


__all__ = [
    "EmailMessage",
    "EmailProvider",
    "EmailResult",
    "get_email_provider",
    "render_magic_link_email",
    "send_magic_link_email",
    "render_signup_confirmation_email",
    "send_signup_confirmation_email",
    "render_password_reset_email",
    "send_password_reset_email",
    "render_oauth_only_password_reset_email",
    "send_oauth_only_password_reset_email",
    "render_password_changed_email",
    "send_password_changed_email",
]
