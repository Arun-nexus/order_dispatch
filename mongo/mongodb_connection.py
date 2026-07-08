import pymongo
import certifi
import os
from logger import logging
import par

ca = certifi.where()

class mongodbclient:
    _client = None
    def __init__(self):

        try:
            if mongodbclient._client is None:
                mongodb_url = os.getenv("connection_url")
                if mongodb_url is None:
                    raise Exception(f"in environment variables mongo_db_url is not set ")

                mongodbclient._client = pymongo.MongoClient(mongodb_url,tlsCAFile = ca)
            self.client = mongodbclient._client
            self.database = self.client[os.getenv("database_name")]
            self.database_name = os.getenv("database_name")
            logging.info("mongodb connection was established successfully")

        except Exception as e:
            raise Exception(e) 