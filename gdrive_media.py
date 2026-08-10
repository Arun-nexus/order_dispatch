"""
Uploads base64-encoded images/videos to Google Drive and returns a shareable link.

Requires these environment variables (same place you set MONGO_URI, JWT_SECRET_KEY):
    GDRIVE_CLIENT_ID       - from the OAuth client JSON you downloaded
    GDRIVE_CLIENT_SECRET   - from the OAuth client JSON you downloaded
    GDRIVE_REFRESH_TOKEN   - obtained once via get_refresh_token.py (see that file)
    GDRIVE_FOLDER_ID       - the Drive folder where files should be uploaded

Install with:
    pip install google-api-python-client google-auth google-auth-oauthlib --break-system-packages
"""

import os
import re
import io
import base64
import uuid

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

_DATA_URI_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$", re.DOTALL)


def _get_drive_service():
    client_id = os.getenv("GDRIVE_CLIENT_ID")
    client_secret = os.getenv("GDRIVE_CLIENT_SECRET")
    refresh_token = os.getenv("GDRIVE_REFRESH_TOKEN")

    if not all([client_id, client_secret, refresh_token]):
        raise Exception("Google Drive credentials are not configured (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN missing)")

    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    return build("drive", "v3", credentials=creds)


def _extension_for_mime(mime: str) -> str:
    mapping = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm",
    }
    return mapping.get(mime, mime.split("/")[-1] if "/" in mime else "bin")


def upload_base64_to_drive(data_uri: str, filename_prefix: str = "media") -> str:
    """
    Takes a base64 data URI (e.g. "data:image/png;base64,....") and uploads it
    to the configured Google Drive folder. Returns a shareable "view" link.
    """
    match = _DATA_URI_RE.match(data_uri or "")
    if not match:
        raise Exception("provided string is not a valid base64 data URI")

    mime = match.group("mime")
    raw_b64 = match.group("data")
    file_bytes = base64.b64decode(raw_b64)

    ext = _extension_for_mime(mime)
    filename = f"{filename_prefix}_{uuid.uuid4().hex[:8]}.{ext}"

    folder_id = os.getenv("GDRIVE_FOLDER_ID")
    file_metadata = {"name": filename}
    if folder_id:
        file_metadata["parents"] = [folder_id]

    media = MediaIoBaseUpload(io.BytesIO(file_bytes), mimetype=mime, resumable=False)

    service = _get_drive_service()
    uploaded = service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id, webViewLink"
    ).execute()

    file_id = uploaded["id"]

    # Make it viewable by anyone with the link (so technicians/admins can open
    # it from the website without needing access to your personal Drive account).
    try:
        service.permissions().create(
            fileId=file_id,
            body={"type": "anyone", "role": "reader"},
        ).execute()
    except Exception:
        # Non-fatal: file is still uploaded, just not link-shared. Owner can
        # still open it from their own Drive.
        pass

    return uploaded.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view"