import pymongo
import certifi
import os
import time
import threading
import contextvars
from logger import logging
from dotenv import load_dotenv

load_dotenv()

ca = certifi.where()

# Per-request DB counters (filled in by the timing middleware in app.py) so a slow request
# can be classified as "one slow query" vs "many small queries" vs "not the DB at all".
db_stats = contextvars.ContextVar("db_stats", default=None)


def _track(op, collection_name, started, extra=""):
    ms = (time.perf_counter() - started) * 1000
    stats = db_stats.get()
    if stats is not None:
        stats["calls"] += 1
        stats["ms"] += ms
    if ms > 300:
        logging.warning(f"SLOW DB {op} on '{collection_name}' took {ms:.0f} ms {extra}")


class mongodbclient:
    _client = None
    _lock = threading.Lock()   # endpoints now run in a threadpool: create the shared client only once

    def __init__(self):
        try:
            if mongodbclient._client is None:
                with mongodbclient._lock:
                    if mongodbclient._client is None:
                        mongodb_url = os.getenv("connection_url")
                        if mongodb_url is None:
                            raise Exception("in environment variables connection_url is not set")

                        # minPoolSize keeps a couple of connections warm; maxIdleTimeMS retires idle sockets
                        # before a NAT/firewall silently drops them (that shows up as multi-second stalls).
                        mongodbclient._client = pymongo.MongoClient(
                            mongodb_url, tlsCAFile=ca, minPoolSize=2, maxIdleTimeMS=60000,
                            serverSelectionTimeoutMS=10000)

            self.client = mongodbclient._client
            self.database = self.client[os.getenv("database_name")]
            self.database_name = os.getenv("database_name")
            logging.info("mongodb connection was established successfully")

        except Exception as e:
            logging.error("cannot establish connection with database")
            raise Exception(e)

    def add(self, collection_name, dictionary: dict):
        try:
            _t = time.perf_counter()
            result = self.database[collection_name].insert_one(dictionary)
            _track("insert", collection_name, _t)
            logging.info(f"document inserted with id: {result.inserted_id}")
            return result.inserted_id
        except Exception as e:
            logging.error("cannot add document in database")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            logging.info("trying to fetch data from the dataset")
            collection = self.database[collection_name]
            query = query or {}
            _t = time.perf_counter()
            results = collection.find(query, projection)
            docs = []
            for doc in results:
                if "_id" in doc:
                    doc["_id"] = str(doc["_id"])
                docs.append(doc)
            _track("find", collection_name, _t, f"docs={len(docs)} query_keys={list(query.keys())}")
            return docs
        except Exception as e:
            logging.error("unable to fetch data from database")
            raise Exception(e)

    def update_data(self, collection_name, query, update_values, many=False):
        try:
            collection = self.database[collection_name]
            update_docs = {"$set": update_values}

            _t = time.perf_counter()
            if many:
                result = collection.update_many(query, update_docs)
            else:
                result = collection.update_one(query, update_docs)
            _track("update", collection_name, _t, f"query_keys={list(query.keys())}")

            logging.info(f"matched: {result.matched_count}, modified: {result.modified_count}")
            return result

        except Exception as e:
            logging.error("unable to update the results")
            raise Exception(e)

    def delete_data(self, collection_name, query, many=False):
        try:
            collection = self.database[collection_name]
            if many:
                result = collection.delete_many(query)
            else:
                result = collection.delete_one(query)

            logging.info(f"deleted count: {result.deleted_count}")
            return result

        except Exception as e:
            logging.error("unable to delete the data")
            raise Exception(e)