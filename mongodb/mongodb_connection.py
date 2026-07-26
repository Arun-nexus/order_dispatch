import pymongo
import certifi
import os
from logger import logging


ca = certifi.where()


class mongodbclient:
    _client = None

    def __init__(self):
        try:
            if mongodbclient._client is None:
                mongodb_url = os.getenv("connection_url")
                if mongodb_url is None:
                    raise Exception("in environment variables connection_url is not set")

                mongodbclient._client = pymongo.MongoClient(mongodb_url, tlsCAFile=ca)

            self.client = mongodbclient._client
            self.database = self.client[os.getenv("database_name")]
            self.database_name = os.getenv("database_name")
            logging.info("mongodb connection was established successfully")

        except Exception as e:
            logging.error("cannot establish connection with database")
            raise Exception(e)

    def add(self, collection_name, dictionary: dict):
        try:
            result = self.database[collection_name].insert_one(dictionary)
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
            results = collection.find(query, projection)
            docs = []
            for doc in results:
                if "_id" in doc:
                    doc["_id"] = str(doc["_id"])
                docs.append(doc)
            return docs
        except Exception as e:
            logging.error("unable to fetch data from database")
            raise Exception(e)

    def update_data(self, collection_name, query, update_values, many=False):
        try:
            collection = self.database[collection_name]
            update_docs = {"$set": update_values}

            if many:
                result = collection.update_many(query, update_docs)
            else:
                result = collection.update_one(query, update_docs)

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
