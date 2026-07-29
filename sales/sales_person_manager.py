from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid


class sales_person_manager(mongodbclient):

    def __init__(self, name=None, company_name=None, address=None, contact_number=None, email=None):
        super().__init__()

        self.sales_person_id = str(uuid.uuid4())
        self.name = name
        self.company_name = company_name
        self.address = address
        self.contact_number = contact_number
        self.email = email

    def add(self, collection_name):
        try:
            sp_dict = {
                "sales_person_id": self.sales_person_id,
                "name": self.name,
                "company_name": self.company_name,
                "address": self.address,
                "contact_number": self.contact_number,
                "email": self.email,
                "created_date": datetime.now(timezone.utc).isoformat()
            }
            result = super().add(collection_name=collection_name, dictionary=sp_dict)
            logging.info("sales person added successfully")
            return result
        except Exception as e:
            logging.error("adding sales person failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            return super().get_data(collection_name, query, projection)
        except Exception as e:
            logging.error("sales person data fetching failed!")
            raise Exception(e)

    def search(self, collection_name, term):
        try:
            regex = {"$regex": term, "$options": "i"}
            query = {"$or": [
                {"name": regex},
                {"company_name": regex},
                {"contact_number": regex},
                {"email": regex},
            ]}
            return self.get_data(collection_name=collection_name, query=query)
        except Exception as e:
            logging.error("sales person search failed!")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            return super().update_data(collection_name=collection_name, query=query,
                                        update_values=update_values, many=many)
        except Exception as e:
            logging.error("sales person update failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            return super().delete_data(collection_name=collection_name, query=query, many=many)
        except Exception as e:
            logging.error("sales person deletion failed!")
            raise Exception(e)