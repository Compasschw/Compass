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


__all__ = [
    "EmailMessage",
    "EmailProvider",
    "EmailResult",
    "get_email_provider",
    "render_magic_link_email",
    "send_magic_link_email",
]
