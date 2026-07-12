import yaml
from logger import logging

def load_params()->dict:
    try:
        with open("params.yaml","r") as f:
            params = yaml.safe_load(f)
            logging.info("parameter file was found" if params else "parmeter file was not found on thye given location")
            return params
    except Exception as e:
        logging.error(f"error occurred in configuration.py")
        raise(e)
        