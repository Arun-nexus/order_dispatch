from dotenv import load_dotenv
load_dotenv()

import os
import pymongo
import certifi

ca = certifi.where()
url = os.getenv("connection_url")
db_name = os.getenv("database_name")

try:
    client = pymongo.MongoClient(url, tlsCAFile=ca, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    print("Connection successful!")
    print("Database name:", db_name)
    print("Existing databases:", client.list_database_names())
except Exception as e:
    print("Connection failed:", e)