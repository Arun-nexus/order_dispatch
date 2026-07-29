from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid


class customer_manager(mongodbclient):

    def __init__(self, company_name=None, company_address=None, gst_number=None,
                 contractor_person=None, contractor_number=None, contractor_email=None):

        super().__init__()

        self.customer_id = str(uuid.uuid4())
        self.company_name = company_name
        self.company_address = company_address
        self.gst_number = gst_number
        self.contractor_person = contractor_person
        self.contractor_number = contractor_number
        self.contractor_email = contractor_email

    def add(self, collection_name):
        try:
            customer_dict = {
                "customer_id": self.customer_id,
                "company_name": self.company_name,
                "company_address": self.company_address,
                "gst_number": self.gst_number,
                "contractor_person": self.contractor_person,
                "contractor_number": self.contractor_number,
                "contractor_email": self.contractor_email,
                "created_date": datetime.now(timezone.utc).isoformat()
            }
            result = super().add(collection_name=collection_name, dictionary=customer_dict)
            logging.info("customer added successfully")
            return result
        except Exception as e:
            logging.error("adding customer failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("customer data fetching failed!")
            raise Exception(e)

    def search(self, collection_name, term):
        try:
            regex = {"$regex": term, "$options": "i"}
            query = {"$or": [
                {"company_name": regex},
                {"gst_number": regex},
                {"contractor_person": regex},
                {"contractor_number": regex},
            ]}
            return self.get_data(collection_name=collection_name, query=query)
        except Exception as e:
            logging.error("customer search failed!")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            return super().update_data(collection_name=collection_name, query=query,
                                        update_values=update_values, many=many)
        except Exception as e:
            logging.error("customer update failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            return super().delete_data(collection_name=collection_name, query=query, many=many)
        except Exception as e:
            logging.error("customer deletion failed!")
            raise Exception(e)