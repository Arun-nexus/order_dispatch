"""
RUN THIS ONCE, ON YOUR OWN LAPTOP (not on Cloud Run / Cloud Shell).

It opens a browser, asks you to log into the Google account whose Drive you
want files to go into, and prints a refresh_token. Copy that value into the
GDRIVE_REFRESH_TOKEN environment variable on Cloud Run.

Setup before running:
    1. pip install google-auth-oauthlib --break-system-packages
    2. Put the credentials.json file you downloaded from Google Cloud Console
       (OAuth client -> Desktop app) in the same folder as this script.
    3. python get_refresh_token.py
    4. A browser window opens - log in with the Google account whose Drive
       you want to use, click Allow.
    5. The refresh token prints in your terminal. Copy it somewhere safe.
"""

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
creds = flow.run_local_server(port=0)

print("\n\n===== COPY THESE INTO CLOUD RUN ENVIRONMENT VARIABLES =====")
print(f"GDRIVE_CLIENT_ID={creds.client_id}")
print(f"GDRIVE_CLIENT_SECRET={creds.client_secret}")
print(f"GDRIVE_REFRESH_TOKEN={creds.refresh_token}")
print("=============================================================")
print("\nAlso create a folder in your Google Drive for these files, open it,")
print("and copy the folder ID from the URL (the part after /folders/) into:")
print("GDRIVE_FOLDER_ID=<your folder id>")