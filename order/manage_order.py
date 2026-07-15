from mongo.mongodb_connection import mongodbclient
from logger import logging
import uuid


class order_manager(mongodbclient):

    def __init__(self, product_name, product_id, company_name, gst_number,payment_mode, price, tax_rate, discount=0):

        super().__init__() 

        self.product_name = product_name
        self.order_id = str(uuid.uuid4())
        self.product_id = product_id
        self.company_name = company_name
        self.gst_number = gst_number
        self.payment_mode = payment_mode
        self.status = "placed"
        self.price = price
        self.tax_rate = tax_rate
        self.discount = discount

    def add(self, collection_name):
        try:
            total_mrp = self.price + (self.tax_rate * self.price / 100) - self.discount

            order_dict = {
                "product_name": self.product_name,
                "order_id": self.order_id,
                "product_id": self.product_id,
                "company_name": self.company_name,
                "gst_number": self.gst_number,
                "payment_mode": self.payment_mode,
                "status": self.status,
                "price": self.price,
                "tax_rate": self.tax_rate,
                "discount": self.discount,
                "total_mrp": total_mrp
            }
            result = super().add(collection_name=collection_name, dictionary=order_dict)
            return result

        except Exception as e:
            logging.error("adding order failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("data fetching was failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            deleted_order = super().delete_data(collection_name=collection_name, query=query, many=many)
            return deleted_order
        except Exception as e:
            logging.error("order deletion was not successful")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            updated_data = super().update_data(collection_name=collection_name, query=query,update_values=update_values, many=many)
            return updated_data
        except Exception as e:
            logging.error("data updation was failed!")
            raise Exception(e)

    def delivery_confirmation(self, collection_name, order_id):
        try:
            result = self.update(collection_name=collection_name,query={"order_id": order_id},update_values={"status": "delivered"})
            logging.info(f"order {order_id} marked as delivered")
            return result
        except Exception as e:
            logging.error("delivery confirmation failed!")
            raise Exception(e)

    def order_tracking(self, collection_name: str, order_id):
        try:
            dataset = self.get_data(collection_name=collection_name, query={"order_id": order_id})
            if not dataset:
                raise Exception(f"no order found with id {order_id}")
            return dataset[0]
        except Exception as e:
            logging.error("order tracking failed!")
            raise Exception(e)
