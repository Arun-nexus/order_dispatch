from mongo.mongodb_connection import mongodbclient
from logger import logging

class inventory_manager(mongodbclient):
    super().__init__()

    def __init__(self,product_name,product_id,quantity,purchase_date,lot_no,supplier,price,tax_rate):
        self.product_name = product_name
        self.product_id = product_id
        self.lot_no = lot_no
        self.supplier = supplier 
        self.price = price
        self.tax_rate = tax_rate
        self.purchase_date = purchase_date
        self.quantity = quantity

    def add(self,collection_name):
        try:
            product_dic = {
                "product_name":self.product_name,
                "product_id":self.product_id,
                "lot_no":self.lot_no,
                "supplier":self.supplier,
                "price":self.price,
                "tax_rate":self.tax_rate,
                "purchase_date":self.purchase_date,
                "quantity":self.quantity + 1
            }
            product = super().add(collection_name=collection_name,dictionary=product_dic)
            logging.info("product added successfully ")
            return product
        except Exception as e:
            logging.error("adding product to inventory was failed!")
            raise Exception(e)
    def update(self,collection_name,query,updated_value):
        try:
            data = super().update_data(collection_name = collection_name,query=query,update_values=updated_value)
            logging.info("value was updated to the inventory!")
            return data
        except Exception as e:
            logging.error("data updation unsuccessful")
            raise Exception(e)
        
    def get_data(self,collection_name,query,projection):
        try:
            dataset = super().get_data(collection_name=collection_name,query=query,projection=projection)
            logging.info("inventory data was fetched successfully")
            return dataset
        except Exception as e:
            logging.error("inventory dataset cannot be fetched!")
            raise Exception(e)

    def delete(self,collection_name):
        try:
            delete = super().delete_data(collection_name=collection_name,query={"product_id":self.product_id})
            total_value = self.get_data(collection_name=collection_name,query={"product_id":self.product_id})
            updated=self.update(collection_name=collection_name,query={"product_id":self.product_id},updated_value=total_value - 1 )
            logging.info("product was successfully deleted and total value was updated")
            return updated
        except Exception as e:
            logging.error("product deletion was unsuccessful")
            raise Exception(e)

    