from mongodb.mongodb_connection import mongodbclient
from logger import logging
from bson import ObjectId
import uuid


class inventory_manager(mongodbclient):

    def __init__(self, product_name=None, product_id=None, quantity=None,
                 purchase_date=None, lot_no=None, supplier=None, price=None, tax_rate=None,
                 model_no=None, supplier_address=None, serial_numbers=None, product_type=None,
                 warranty_until=None, reason=""):

        super().__init__()

        self.product_name = product_name
        self.product_id = product_id
        self.lot_no = lot_no
        self.supplier = supplier
        self.price = price
        self.tax_rate = tax_rate
        self.purchase_date = purchase_date
        self.quantity = quantity
        self.model_no = model_no
        self.supplier_address = supplier_address
        self.serial_numbers = serial_numbers or []
        # "product" | "spare_parts" | "damaged" | "accessories"
        self.product_type = product_type or "product"
        # only meaningful for "damaged" entries created from a swapped-out
        # faulty part: warranty_until carries the source shipment lot's
        # warranty expiry forward (so /inventory/'s dynamic warranty_status
        # calc picks it up), and reason records why it's flagged (e.g. which
        # service/serial it was pulled from when it's already out of warranty)
        self.warranty_until = warranty_until
        self.reason = reason

    def add(self, collection_name):
        try:
            product_dic = {
                "product_name": self.product_name,
                "product_id": self.product_id,
                "lot_no": self.lot_no,
                "supplier": self.supplier,
                "supplier_address": self.supplier_address,
                "price": self.price,
                "tax_rate": self.tax_rate,
                "purchase_date": self.purchase_date,
                "quantity": self.quantity,
                "model_no": self.model_no,
                "serial_numbers": self.serial_numbers,
                "product_type": self.product_type,
                "warranty_until": self.warranty_until,
                "reason": self.reason,
            }
            product = super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info("product added successfully")
            return product
        except Exception as e:
            logging.error("adding product to inventory was failed!")
            raise Exception(e)

    def add_or_merge(self, collection_name):
        """
        Used by the "Add Existing Product" restock flow. If an entry already
        exists for this exact product_name + product_id + model_no, the new
        serial numbers are appended to it and its quantity is increased —
        instead of creating a second, separate document for the same product
        (which used to make the table/eye-view ambiguous about which lot's
        quantity/serials belong to which row). Otherwise a fresh entry is
        created, same as add().
        """
        try:
            existing = self.get_data(
                collection_name=collection_name,
                query={"product_name": self.product_name, "product_id": self.product_id, "model_no": self.model_no}
            )
            if existing:
                entry = existing[0]
                current_serials = entry.get("serial_numbers") or []
                duplicates = [s for s in self.serial_numbers if s in current_serials]
                if duplicates:
                    raise Exception(f"serial number(s) already exist on this product: {', '.join(duplicates)}")

                merged_serials = current_serials + list(self.serial_numbers)
                new_quantity = int(entry.get("quantity", 0) or 0) + int(self.quantity or 0)

                update_values = {
                    "serial_numbers": merged_serials,
                    "quantity": new_quantity,
                    "lot_no": self.lot_no,
                    "supplier": self.supplier,
                    "supplier_address": self.supplier_address,
                    "price": self.price,
                    "tax_rate": self.tax_rate,
                    "purchase_date": self.purchase_date,
                }
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values=update_values
                )
                logging.info(f"merged {self.quantity} unit(s) into existing inventory entry for {self.product_id}")
                return {"mode": "merged", "product_id": self.product_id, "quantity_added": self.quantity}

            return self.add(collection_name=collection_name)

        except Exception as e:
            logging.error("adding/merging inventory entry failed!")
            raise Exception(e)

    def restock_returned_units(self, collection_name, product_id, product_name, model_no, quantity, serial_numbers=None):
        """
        Used when a previously allocated (undamaged) unit is returned and needs
        to go back into inventory. Adds `quantity` back onto the lot that
        matches product_id + product_name + model_no exactly — same matching
        as add_or_merge — so a returned unit of one variant is never merged
        into a different variant's stock, and appends `serial_numbers` back
        onto that lot's serial list.

        Deliberately does NOT touch lot_no/supplier/price/tax_rate/purchase_date
        the way add_or_merge does: add_or_merge is for the "Add Existing
        Product" restock flow, where the user is re-entering fresh purchase
        info for a new physical lot, so overwriting those fields is correct
        there. A return isn't a new purchase — the original lot's purchase
        metadata must be left exactly as it was.

        If the original lot document no longer exists (e.g. it was deleted
        after being fully allocated out), falls back to creating a minimal new
        entry so the returned stock isn't silently lost.
        """
        try:
            query = {"product_id": product_id, "product_name": product_name, "model_no": model_no or ""}
            existing = self.get_data(collection_name=collection_name, query=query)
            if existing:
                entry = existing[0]
                current_serials = entry.get("serial_numbers") or []
                merged_serials = current_serials + list(serial_numbers or [])
                new_quantity = int(entry.get("quantity", 0) or 0) + int(quantity or 0)
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": merged_serials, "quantity": new_quantity}
                )
                logging.info(f"restocked {quantity} returned unit(s) into existing inventory entry for {product_id}")
                return {"mode": "merged", "product_id": product_id, "quantity_added": quantity}

            from datetime import datetime, timezone
            fallback = inventory_manager(
                product_name=product_name,
                product_id=product_id,
                model_no=model_no or "",
                quantity=quantity,
                purchase_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                lot_no="",
                supplier="",
                price="",
                tax_rate=0,
                serial_numbers=list(serial_numbers or []),
                product_type="product",
            )
            logging.info(f"original lot for {product_id} no longer exists — created fallback entry for returned stock")
            return fallback.add(collection_name=collection_name)

        except Exception as e:
            logging.error("restocking returned unit(s) failed!")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            data = super().update_data(collection_name=collection_name, query=query,
                                         update_values=update_values, many=many)
            logging.info("value was updated to the inventory!")
            return data
        except Exception as e:
            logging.error("data updation unsuccessful")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name=collection_name, query=query, projection=projection)
            logging.info("inventory data was fetched successfully")
            return dataset
        except Exception as e:
            logging.error("inventory dataset cannot be fetched!")
            raise Exception(e)

    def delete(self, collection_name):
        try:
            existing = self.get_data(collection_name=collection_name, query={"product_id": self.product_id})
            if not existing:
                raise Exception(f"no product found with id {self.product_id}")

            deleted = super().delete_data(collection_name=collection_name,
                                            query={"product_id": self.product_id})
            logging.info("product was successfully deleted from inventory")
            return deleted
        except Exception as e:
            logging.error("product deletion was unsuccessful")
            raise Exception(e)

    def get_available_quantity(self, collection_name, product_id, model_no=None):
        try:
            query = {"product_id": product_id}
            # model_no disambiguates between variants sharing the same product_id
            # (e.g. black vs grey) — only filter by it when one was actually given,
            # so callers that intentionally want the product_id-wide total still can
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(collection_name=collection_name, query=query)
            return sum(int(e.get("quantity", 0) or 0) for e in entries)
        except Exception as e:
            logging.error("checking available quantity failed!")
            raise Exception(e)

    def get_available_quantity_by_name(self, collection_name, product_name, product_type):
        """
        Same idea as get_available_quantity, but for entries that have no
        natural product_id (e.g. spare_parts pushed in from a shipment) —
        sums quantity across every entry matching product_name + product_type.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_type": product_type}
            )
            return sum(int(e.get("quantity", 0) or 0) for e in entries)
        except Exception as e:
            logging.error("checking available quantity by name failed!")
            raise Exception(e)

    def get_hologram_available_by_name(self, collection_name, product_name, product_type):
        """
        Sums how many hologram numbers are on file (across every matching lot)
        for a product_name + product_type — used before assembly to make sure
        there's a hologram number for every unit about to be consumed.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_type": product_type}
            )
            return sum(len(e.get("hologram_numbers") or []) for e in entries)
        except Exception as e:
            logging.error("checking available hologram numbers by name failed!")
            raise Exception(e)

    def consume_quantity(self, collection_name, product_name, product_type, quantity):
        """
        Deducts `quantity` units of a non-serialized product (e.g. a
        spare_parts entry) identified by product_name + product_type,
        oldest lots (by purchase_date) first. Raises if stock is insufficient.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_type": product_type, "quantity": {"$gt": 0}}
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            for entry in entries:
                if remaining <= 0:
                    break
                available = int(entry.get("quantity", 0) or 0)
                take = min(remaining, available)
                if take <= 0:
                    continue
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"quantity": available - take}
                )
                remaining -= take

            if remaining > 0:
                raise Exception(f"insufficient stock for '{product_name}', short by {remaining}")

            logging.info(f"consumed {quantity} unit(s) of '{product_name}' from {product_type}")
            return quantity
        except Exception as e:
            logging.error("consuming quantity from inventory failed!")
            raise Exception(e)

    def allocate_hologram_numbers_by_name(self, collection_name, product_name, product_type, quantity):
        """
        Deducts `quantity` units of a spare_parts/service_parts entry (matched by
        product_name + product_type) AND pulls that many hologram numbers along with
        it — oldest lots first, same pattern as allocate_serials below. Every unit
        consumed this way must have its own hologram number on file; raises if
        either the stock or the hologram numbers on file fall short. Returns the
        flat list of hologram numbers taken, in the order they were consumed — this
        becomes the per-unit hologram_number for the assembly's serials.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_type": product_type, "quantity": {"$gt": 0}}
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            # verify enough hologram numbers exist across all matching lots before touching anything
            total_hologram = sum(len(e.get("hologram_numbers") or []) for e in entries)
            if total_hologram < quantity:
                raise Exception(
                    f"only {total_hologram} hologram number(s) on file for '{product_name}', need {quantity}"
                )

            remaining = quantity
            allocated = []
            for entry in entries:
                if remaining <= 0:
                    break
                available_qty = int(entry.get("quantity", 0) or 0)
                available_hologram = entry.get("hologram_numbers") or []
                take = min(remaining, available_qty, len(available_hologram))
                if take <= 0:
                    continue
                taken = available_hologram[:take]
                leftover_hologram = available_hologram[take:]
                new_quantity = available_qty - take
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"hologram_numbers": leftover_hologram, "quantity": new_quantity}
                )
                allocated.extend(taken)
                remaining -= take

            if remaining > 0:
                raise Exception(f"insufficient hologram-tagged stock for '{product_name}', short by {remaining}")

            logging.info(f"allocated {len(allocated)} hologram number(s) for '{product_name}'")
            return allocated
        except Exception as e:
            logging.error("hologram number allocation failed!")
            raise Exception(e)

    def list_available_serials(self, collection_name, product_id, model_no=None):
        """
        Returns every serial number currently on file for product_id (optionally
        scoped to a single model_no variant), oldest lot first — the exact same
        order allocate_serials/allocate_units would consume them in. Used to
        populate the order review step's serial-number picker, so the "default"
        selection shown to the user matches what auto-allocation would have
        picked, and the rest of the list is what's available to switch to.
        """
        try:
            query = {"product_id": product_id, "quantity": {"$gt": 0}}
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(collection_name=collection_name, query=query)
            entries.sort(key=lambda e: e.get("purchase_date") or "")
            serials = []
            for entry in entries:
                serials.extend(entry.get("serial_numbers") or [])
            return serials
        except Exception as e:
            logging.error("listing available serial numbers failed!")
            raise Exception(e)

    def allocate_specific_serials(self, collection_name, product_id, serial_numbers, model_no=None):
        """
        Deducts exactly the given serial_numbers (a manual/reviewed selection
        from the order UI, as opposed to allocate_serials' auto oldest-first
        pick) — one unit per serial, decrementing whichever lot each serial
        actually belongs to. model_no scopes the search to a single variant's
        lots, same as allocate_serials/allocate_units, so a serial can't be
        pulled from the wrong variant.

        Every serial must currently exist in some matching lot's serial_numbers
        list; if any one of them isn't found (already allocated to another
        order in the meantime, mistyped, or belongs to a different product),
        the whole call raises before anything is deducted for THAT serial —
        serials already processed earlier in the same call are not rolled
        back, matching this codebase's existing non-transactional style
        elsewhere (e.g. allocate_serials/allocate_units).
        """
        try:
            query = {"product_id": product_id, "quantity": {"$gt": 0}}
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(collection_name=collection_name, query=query)

            allocated = []
            for serial in serial_numbers:
                match = next((e for e in entries if serial in (e.get("serial_numbers") or [])), None)
                if not match:
                    variant_note = f" (model {model_no})" if model_no else ""
                    raise Exception(f"serial number {serial} is not available for product {product_id}{variant_note}")

                leftover_serials = [s for s in (match.get("serial_numbers") or []) if s != serial]
                new_quantity = int(match.get("quantity", 0) or 0) - 1
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(match["_id"])},
                    update_values={"serial_numbers": leftover_serials, "quantity": new_quantity}
                )
                # keep our local view in sync so two requested serials from the
                # same lot in one call don't both match the stale entry
                match["serial_numbers"] = leftover_serials
                match["quantity"] = new_quantity

                allocated.append(serial)

            logging.info(f"allocated {len(allocated)} specific serial(s) for product {product_id}")
            return allocated
        except Exception as e:
            logging.error("allocating specific serial number(s) failed!")
            raise Exception(e)
        """
        Pulls `quantity` serial numbers out of inventory for product_id (oldest lots first),
        decrementing each lot's quantity and removing the used serials. Returns the list of
        serial numbers allocated. Raises if stock is insufficient.

        model_no disambiguates between variants that share the same product_id
        (e.g. the same product in black vs grey, each its own model_no lot) — when
        given, only lots for that exact model_no are eligible, so a request for
        one variant can never silently pull serials from another.
        """
        try:
            query = {"product_id": product_id, "quantity": {"$gt": 0}}
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(
                collection_name=collection_name,
                query=query
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            allocated = []

            for entry in entries:
                if remaining <= 0:
                    break

                available_serials = entry.get("serial_numbers") or []
                take = min(remaining, len(available_serials), int(entry.get("quantity", 0) or 0))
                if take <= 0:
                    continue

                taken_serials = available_serials[:take]
                leftover_serials = available_serials[take:]
                new_quantity = int(entry.get("quantity", 0) or 0) - take

                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": leftover_serials, "quantity": new_quantity}
                )

                allocated.extend(taken_serials)
                remaining -= take

            if remaining > 0:
                variant_note = f" (model {model_no})" if model_no else ""
                raise Exception(f"insufficient stock for product {product_id}{variant_note}, short by {remaining}")

            logging.info(f"allocated {len(allocated)} serials for product {product_id}")
            return allocated

        except Exception as e:
            logging.error("serial allocation failed!")
            raise Exception(e)

    def allocate_units(self, collection_name, product_id, quantity, model_no=None):
        """
        Deducts `quantity` units of product_id from inventory (oldest lots first) —
        for use anywhere a full quantity+serials list is recorded together (e.g. an
        order line or a demo-unit allocation line), as opposed to allocate_serials'
        one-record-per-serial callers which genuinely need every unit serialed.

        model_no disambiguates between variants that share the same product_id
        (e.g. the same product in black vs grey, each its own model_no lot) — when
        given, only lots for that exact model_no are eligible, so a line ordered
        for one variant can never silently pull stock/serials from another.

        Unlike allocate_serials, this does NOT require every lot to carry serial
        numbers: accessories/spare_parts/service_parts are allowed to be stocked
        with no serial numbers on file (see /inventory/create), so a lot with
        quantity > 0 but an empty serial_numbers list is still valid stock and
        must not raise "insufficient stock". Wherever a lot does have serials on
        file, the matching number of serials is pulled and returned so the caller
        can still record which units shipped for serialized products.

        Returns the list of serial numbers collected — this may be SHORTER than
        `quantity` (or empty) when the consumed lots weren't serial-tracked; that
        is expected and not an error. Raises only if total on-file quantity across
        all matching lots is insufficient.
        """
        try:
            query = {"product_id": product_id, "quantity": {"$gt": 0}}
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(
                collection_name=collection_name,
                query=query
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            allocated = []

            for entry in entries:
                if remaining <= 0:
                    break

                available_qty = int(entry.get("quantity", 0) or 0)
                take = min(remaining, available_qty)
                if take <= 0:
                    continue

                available_serials = entry.get("serial_numbers") or []
                serial_take = min(take, len(available_serials))
                taken_serials = available_serials[:serial_take]
                leftover_serials = available_serials[serial_take:]

                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": leftover_serials, "quantity": available_qty - take}
                )

                allocated.extend(taken_serials)
                remaining -= take

            if remaining > 0:
                variant_note = f" (model {model_no})" if model_no else ""
                raise Exception(f"insufficient stock for product {product_id}{variant_note}, short by {remaining}")

            logging.info(f"allocated {quantity} unit(s) ({len(allocated)} serialed) for product {product_id}{' model ' + model_no if model_no else ''}")
            return allocated

        except Exception as e:
            logging.error("unit allocation failed!")
            raise Exception(e)

    def add_from_assembly(self, collection_name, product_name, product_id, model_no, quantity,
                           serial_numbers, price=0, tax_rate=0, purchase_date=None,
                           supplier="In-house Assembly", supplier_address="", lot_no="",
                           product_type="product"):
        """
        Called right after an Assembly is marked completed, to push the
        freshly built units into inventory.

        If an inventory entry already exists with the same product_name +
        product_id + model_no, the assembled serial numbers are appended to
        that entry and its quantity is increased by `quantity`. Otherwise a
        brand new inventory entry is created for this assembled batch.

        Returns {"mode": "merged" | "created", "product_id": ..., "quantity_added": ...}
        """
        try:
            if not product_name or not product_id:
                raise Exception("assembled product must have a product name and product id")
            if not quantity or quantity <= 0:
                raise Exception("assembled quantity must be greater than 0")

            existing = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_id": product_id, "model_no": model_no}
            )

            if existing:
                entry = existing[0]
                merged_serials = (entry.get("serial_numbers") or []) + list(serial_numbers)
                new_quantity = int(entry.get("quantity", 0) or 0) + quantity

                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": merged_serials, "quantity": new_quantity}
                )
                logging.info(f"merged {quantity} assembled unit(s) into existing inventory entry for {product_id}")
                return {"mode": "merged", "product_id": product_id, "quantity_added": quantity}

            product_dic = {
                "product_name": product_name,
                "product_id": product_id,
                "lot_no": lot_no,
                "supplier": supplier,
                "supplier_address": supplier_address,
                "price": price,
                "tax_rate": tax_rate,
                "purchase_date": purchase_date,
                "quantity": quantity,
                "model_no": model_no,
                "serial_numbers": list(serial_numbers),
                "product_type": product_type,
            }
            super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info(f"created new inventory entry for assembled product {product_id}")
            return {"mode": "created", "product_id": product_id, "quantity_added": quantity}

        except Exception as e:
            logging.error("pushing assembled units into inventory failed!")
            raise Exception(e)

    def add_from_shipment_parts(self, collection_name, parts, product_type,
                                 supplier="", supplier_address="", purchase_date=None, lot_no=""):
        """
        Called right after a Shipment is marked received, to push its parts
        into inventory — grouped here by product_type so the caller decides
        which bucket they land in:
          - parts marked "assembly" on the shipment -> product_type="spare_parts"
          - parts marked "purchase" / "warranty" on the shipment -> product_type="service_parts"

        parts: list of {
            "part_name": str,
            "parent_product_name": str,                        # which shipment product this part belongs to
            "quantity": int,
            "part_category": "purchase" | "warranty" | None,  # only meaningful for service_parts
            "warranty_until": "YYYY-MM-DD" | None,             # only meaningful when part_category == "warranty"
        }

        Unlike assembled units, shipment parts have no serial numbers (they're
        tracked purely by quantity) and no natural product_id, so:
          - if an inventory entry with the same product_name + parent_product_name +
            product_type + part_category + purchase_date + warranty_until already
            exists, its quantity is simply increased
          - otherwise a new entry is created with an auto-generated product_id

        purchase_date and warranty_until are part of the match on purpose: two
        shipments of the "same" part received on different dates, or covered by
        different warranty windows, must NOT collapse into one inventory row —
        each stays its own lot with its own date/warranty so nothing gets mixed.

        Returns a list of {"part_name", "mode": "merged" | "created", "quantity_added"}
        """
        try:
            results = []
            for part in parts:
                part_name = (part.get("part_name") or "").strip()
                parent_product_name = (part.get("parent_product_name") or "").strip()
                quantity = part.get("quantity", 0) or 0
                if not part_name or quantity <= 0:
                    continue

                part_category = part.get("part_category")     # None | "purchase" | "warranty"
                warranty_until = part.get("warranty_until")    # only set for "warranty"

                # keep purchase / warranty batches of the same part separate,
                # and keep the same part name sourced from different products
                # separate too, so their category/parent isn't lost on merge.
                # purchase_date and warranty_until are ALSO part of the match:
                # two shipments of the same part received on different dates,
                # or with different warranty windows, must land in separate
                # inventory rows instead of merging their quantity together
                # (which would silently mix two different dates/warranties).
                match_query = {
                    "product_name": part_name,
                    "parent_product_name": parent_product_name,
                    "product_type": product_type,
                    "purchase_date": purchase_date,
                    "warranty_until": warranty_until,
                }
                if part_category:
                    match_query["part_category"] = part_category

                existing = self.get_data(collection_name=collection_name, query=match_query)

                if existing:
                    # purchase_date and warranty_until are guaranteed identical
                    # to the existing entry here (they're part of match_query
                    # above), so merging only ever adds quantity - it never
                    # overwrites/mixes a different date or warranty window.
                    entry = existing[0]
                    new_quantity = int(entry.get("quantity", 0) or 0) + quantity
                    self.update_data(
                        collection_name=collection_name,
                        query={"_id": ObjectId(entry["_id"])},
                        update_values={"quantity": new_quantity}
                    )
                    logging.info(f"merged {quantity} unit(s) of '{part_name}' into existing {product_type} entry")
                    results.append({"part_name": part_name, "mode": "merged", "quantity_added": quantity})
                else:
                    product_id = f"SP-{uuid.uuid4().hex[:8].upper()}"
                    product_dic = {
                        "product_name": part_name,
                        "parent_product_name": parent_product_name,
                        "product_id": product_id,
                        "lot_no": lot_no,
                        "supplier": supplier,
                        "supplier_address": supplier_address,
                        "price": 0,
                        "tax_rate": 0,
                        "purchase_date": purchase_date,
                        "quantity": quantity,
                        "model_no": "",
                        "serial_numbers": [],
                        "product_type": product_type,
                        "part_category": part_category,
                        "warranty_until": warranty_until,
                    }
                    super().add(collection_name=collection_name, dictionary=product_dic)
                    logging.info(f"created new {product_type} inventory entry for '{part_name}'")
                    results.append({"part_name": part_name, "mode": "created", "quantity_added": quantity})

            return results

        except Exception as e:
            logging.error("pushing shipment parts into inventory failed!")
            raise Exception(e)