/**
 * @route /api/warehouse
 */
const express = require("express");
const Router = express.Router();
const moment = require("moment");
const cron = require("node-cron");
const { connection } = require("../startup/db");
const asyncMiddleware = require("../middlewares/asyncMiddleware");
const {
  limiter_10_1,
  validateCreateDispatchRequest,
  validateAddOrderRequest,
  validateUpdateDispatchRequest,
  validateRemovalRequest,
  validateLogRequest,
  validateCreateWarehouseReturnRequest,
  validateAddReturnOrderRequest,
  validateUpdateWarehouseReturnRequest,
  validateReturnLogRequest,
} = require("../models/warehouse");
const auth = require("../middlewares/auth");
const admin = require("../middlewares/admin");
const { getPagination } = require("../utils/helpers");

// Timezone offset for Dhaka, Bangladesh (UTC+6)
const DHAKA_TIMEZONE_OFFSET = 6;

/**
 * Create a new warehouse dispatch
 * @method POST
 * @url /api/warehouse/dispatches
 * @access Private
 * @returns {Object} dispatch
 */
Router.post(
  "/dispatches",
  [auth, admin],
  limiter_10_1,
  asyncMiddleware(async (req, res) => {
    const error = validateCreateDispatchRequest(req, res);
    if (error) return;

    const { store_id, dispatch_date, notes, metadata } = req.body;

    // Check if there is any in_progress dispatch
    const [inProgressDispatch] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE store_id = ? AND dispatch_status = 'in_progress'
    `,
      [store_id],
    );

    if (inProgressDispatch.length > 0) {
      return res.status(400).send({
        status: 400,
        message:
          "There is already an in-progress dispatch. Please finalize it before creating a new one.",
        dispatch_id: inProgressDispatch[0].dispatch_id,
      });
    }

    // Check if there is already a dispatch for this date
    const [existingDispatch] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE store_id = ? AND dispatch_date = ?
    `,
      [store_id, dispatch_date],
    );

    if (existingDispatch.length > 0) {
      return res.status(400).send({
        status: 400,
        message: "A dispatch already exists for this date.",
        dispatch_id: existingDispatch[0].dispatch_id,
      });
    }

    // Create the dispatch
    const [result] = await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatches (
            store_id, 
            dispatch_date, 
            dispatch_status, 
            created_by, 
            notes, 
            metadata
        ) VALUES (?, ?, 'in_progress', ?, ?, ?)
    `,
      [
        store_id,
        dispatch_date,
        req.user.user_id,
        notes || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    const dispatch_id = result.insertId;

    // Create a log entry for the creation
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description
        ) VALUES (?, ?, 'created', 'Dispatch created')
    `,
      [dispatch_id, req.user.user_id],
    );

    // Get the created dispatch
    const [dispatch] = await connection.promise().query(
      /*sql*/ `
        SELECT d.*, 
               creator.name AS creator_name, 
               s.name AS store_name
        FROM warehouse_dispatches d
        JOIN store_admins creator ON d.created_by = creator.user_id
        JOIN stores s ON d.store_id = s.store_id
        WHERE d.dispatch_id = ?
    `,
      [dispatch_id],
    );

    res.status(201).send({
      status: 201,
      message: "Warehouse dispatch created successfully",
      dispatch: dispatch[0],
    });
  }),
);

/**
 * Get all warehouse dispatches with pagination and filtering
 * @method GET
 * @url /api/warehouse/dispatches
 * @access Private
 * @returns {Array} dispatches
 */
Router.get(
  "/dispatches",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const { store_id, dispatch_status, from_date, to_date, search } = req.query;

    if (!store_id) {
      return res
        .status(400)
        .send({ status: 400, message: "Store ID is required" });
    }

    let sqlWhere = " WHERE d.store_id = ?";
    let sqlParams = [store_id];

    if (dispatch_status) {
      sqlWhere += " AND d.dispatch_status = ?";
      sqlParams.push(dispatch_status);
    }

    if (from_date) {
      sqlWhere += " AND d.dispatch_date >= ?";
      sqlParams.push(from_date);
    }

    if (to_date) {
      sqlWhere += " AND d.dispatch_date <= ?";
      sqlParams.push(to_date);
    }

    if (search) {
      sqlWhere += " AND (d.dispatch_id LIKE ? OR d.notes LIKE ?)";
      sqlParams.push(`%${search}%`, `%${search}%`);
    }

    const sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    // Get dispatches with creator and store names
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT d.*, 
               creator.name AS creator_name, 
               finalizer.name AS finalizer_name, 
               s.name AS store_name
        FROM warehouse_dispatches d
        JOIN store_admins creator ON d.created_by = creator.user_id
        LEFT JOIN store_admins finalizer ON d.finalized_by = finalizer.user_id
        JOIN stores s ON d.store_id = s.store_id
        ${sqlWhere}
        ORDER BY d.created_at DESC
        ${sqlLimit}
    `,
      sqlParams,
    );

    // Get total count for pagination
    const [totalResult] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total FROM warehouse_dispatches d ${sqlWhere}
    `,
      sqlParams,
    );

    const total = totalResult[0].total;

    res.send({
      status: 200,
      dispatches,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  }),
);

Router.get(
  "/dispatches/same-day-orders",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { from_date, to_date, store_id } = req.query;

    if (!store_id) {
      return res.status(400).send({
        status: 400,
        message: "Store ID is required",
      });
    }

    // default to today's date in Dhaka (UTC+6) when from_date/to_date not provided
    const todayDhaka = moment()
      .add(DHAKA_TIMEZONE_OFFSET, "hours")
      .format("YYYY-MM-DD");
    const from = from_date || todayDhaka;
    const to = to_date || todayDhaka;

    let dateFilter = "";
    let params = [store_id];

    if (from && to) {
      dateFilter = "AND DATE(o.created_at) BETWEEN ? AND ?";
      params.push(from, to);
    }

    // Get total statistics
    const [totals] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            COUNT(DISTINCT o.order_id) as total_orders,
            SUM(oi.quantity) as total_items,
            SUM(o.grand_total) as total_value
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN warehouse_dispatch_orders wdo ON o.order_id = wdo.order_id
        JOIN warehouse_dispatches d ON wdo.dispatch_id = d.dispatch_id
        WHERE d.store_id = ?
        ${dateFilter}
        AND DATE(o.created_at) = DATE(d.dispatch_date)
    `,
      params,
    );

    // Get product-wise summary
    const [products] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            oi.product_id,
            oi.variant_id,
            oi.bundle_id,
            oi.name as product_name,
            COALESCE(pvoc.sku_code, CONCAT('BUNDLE-', pb.product_bundle_id), 'N/A') AS sku,
            pvoc.variant_name,
            SUM(oi.quantity) as total_quantity,
            AVG(oi.price) as avg_price,
            SUM(oi.quantity * oi.price) as total_value,
            COALESCE(pvoc.images, NULL) AS product_images
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        JOIN warehouse_dispatch_orders wdo ON o.order_id = wdo.order_id
        JOIN warehouse_dispatches d ON wdo.dispatch_id = d.dispatch_id
        LEFT JOIN product_variant_option_combinations pvoc ON oi.variant_id = pvoc.sku_id
        LEFT JOIN product_bundles pb ON oi.bundle_id = pb.product_bundle_id
        WHERE d.store_id = ?
        ${dateFilter}
        AND DATE(o.created_at) = DATE(d.dispatch_date)
        GROUP BY 
            oi.product_id,
            oi.variant_id,
            oi.bundle_id,
            oi.name,
            pvoc.sku_code,
            pvoc.variant_name,
            pb.product_bundle_id
        ORDER BY total_value DESC
    `,
      params,
    );

    // Format product data
    const formattedProducts = products.map((product) => {
      let images = [];
      if (product.product_images) {
        try {
          const parsedImages = product.product_images
            ?.split(",")
            .map((image) => image.trim());
          images = Array.isArray(parsedImages) ? parsedImages : [];
        } catch (e) {
          console.error("Error parsing product images:", e);
        }
      }

      return {
        product_id: product.product_id,
        variant_id: product.variant_id,
        bundle_id: product.bundle_id,
        sku: product.sku,
        product_name: product.product_name,
        variant_name: product.variant_name,
        total_quantity: product.total_quantity,
        avg_price: parseFloat(product.avg_price),
        total_value: parseFloat(product.total_value),
        thumbnail: images.length > 0 ? images[0] : null,
      };
    });

    res.send({
      status: 200,
      summary: {
        totals: {
          total_orders: totals[0].total_orders,
          total_items: totals[0].total_items,
          total_value: totals[0].total_value,
        },
        products: formattedProducts,
      },
    });
  }),
);
// ...existing code...
/**
 * Get a specific warehouse dispatch by ID
 * @method GET
 * @url /api/warehouse/dispatches/:dispatch_id
 * @access Private
 * @returns {Object} dispatch
 */
Router.get(
  "/dispatches/:dispatch_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;
    const { with_orders, with_products, with_logs } = req.query;

    // Get the dispatch
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT d.*, 
               creator.name AS creator_name, 
               finalizer.name AS finalizer_name, 
               s.name AS store_name
        FROM warehouse_dispatches d
        JOIN store_admins creator ON d.created_by = creator.user_id
        LEFT JOIN store_admins finalizer ON d.finalized_by = finalizer.user_id
        JOIN stores s ON d.store_id = s.store_id
        WHERE d.dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    const dispatch = dispatches[0];

    // Include orders if requested
    if (with_orders === "true") {
      const [orders] = await connection.promise().query(
        /*sql*/ `
            SELECT do.*, 
                   o.order_status, o.fulfillment_status, o.grand_total, o.created_at AS order_created_at,
                   u.name AS user_name, u.phone AS user_phone,
                   adder.name AS added_by_name
            FROM warehouse_dispatch_orders do
            JOIN orders o ON do.order_id = o.order_id
            JOIN users u ON o.user_id = u.user_id
            JOIN store_admins adder ON do.added_by = adder.user_id
            WHERE do.dispatch_id = ?
            ORDER BY do.added_at DESC
        `,
        [dispatch_id],
      );

      dispatch.orders = orders;
    }

    // Include products if requested
    if (with_products === "true") {
      const [products] = await connection.promise().query(
        /*sql*/ `
            SELECT dp.*
            FROM warehouse_dispatch_products dp
            WHERE dp.dispatch_id = ?
            ORDER BY dp.name ASC
        `,
        [dispatch_id],
      );

      dispatch.products = products;
    }

    // Include logs if requested
    if (with_logs === "true") {
      const [logs] = await connection.promise().query(
        /*sql*/ `
            SELECT dl.*, sa.name AS user_name
            FROM warehouse_dispatch_logs dl
            JOIN store_admins sa ON dl.user_id = sa.user_id
            WHERE dl.dispatch_id = ?
            ORDER BY dl.created_at DESC
        `,
        [dispatch_id],
      );

      dispatch.logs = logs;
    }

    res.send({
      status: 200,
      dispatch,
    });
  }),
);

/**
 * Add an order to a warehouse dispatch
 * @method POST
 * @url /api/warehouse/dispatches/orders
 * @access Private
 * @returns {Object} message
 */
Router.post(
  "/dispatches/orders",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateAddOrderRequest(req, res);
    if (error) return;

    const { dispatch_id, order_id } = req.body;

    // Check if dispatch exists and is in progress
    const [dispatch] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatch.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    if (dispatch[0].dispatch_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot add orders to a dispatch with status '${dispatch[0].dispatch_status}'`,
      });
    }

    // Check if order exists
    const [order] = await connection.promise().query(
      /*sql*/ `
        SELECT o.*, u.name AS user_name 
        FROM orders o
        JOIN users u ON o.user_id = u.user_id
        WHERE o.order_id = ?
    `,
      [order_id],
    );

    if (order.length === 0) {
      return res.status(404).send({ status: 404, message: "Order not found" });
    }

    if (order[0]?.order_status !== "processing") {
      return res.status(400).send({
        status: 400,
        message: `Cannot add order with status '${order[0].order_status}' to dispatch`,
      });
    }

    // Check if order is already in this dispatch
    const [existingOrder] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatch_orders 
        WHERE dispatch_id = ? AND order_id = ?
    `,
      [dispatch_id, order_id],
    );

    if (existingOrder.length > 0) {
      return res
        .status(400)
        .send({ status: 400, message: "Order is already in this dispatch" });
    }

    // Check if order is already in another dispatch
    const [otherDispatch] = await connection.promise().query(
      /*sql*/ `
        SELECT wd.dispatch_id, wd.dispatch_date, wd.dispatch_status
        FROM warehouse_dispatch_orders wdo
        JOIN warehouse_dispatches wd ON wdo.dispatch_id = wd.dispatch_id
        WHERE wdo.order_id = ? AND wd.dispatch_id != ?
    `,
      [order_id, dispatch_id],
    );

    if (otherDispatch.length > 0) {
      return res.status(400).send({
        status: 400,
        message: `Order is already in another dispatch (ID: ${otherDispatch[0].dispatch_id}, Date: ${moment(otherDispatch[0].dispatch_date).subtract(DHAKA_TIMEZONE_OFFSET, "hours").format("YYYY-MM-DD")}, Status: ${otherDispatch[0].dispatch_status})`,
      });
    }

    // Add order to dispatch
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_orders (
            dispatch_id, 
            order_id, 
            added_by
        ) VALUES (?, ?, ?)
    `,
      [dispatch_id, order_id, req.user.user_id],
    );

    // Update total_orders count in the dispatch
    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_dispatches 
        SET total_orders = total_orders + 1
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    // Process and update product quantities and values in dispatch_products
    await processOrderProducts(dispatch_id, order_id);

    // Create a log entry
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description,
            metadata
        ) VALUES (?, ?, 'order_added', ?, ?)
    `,
      [
        dispatch_id,
        req.user.user_id,
        `Order #${order_id} (${order[0].user_name}) added to dispatch`,
        JSON.stringify({ order_id, user_name: order[0].user_name }),
      ],
    );

    res.send({
      status: 200,
      message: `Order #${order_id} successfully added to dispatch`,
    });
  }),
);

/**
 * Request removal of an order from a warehouse dispatch
 * @method POST
 * @url /api/warehouse/dispatches/:dispatch_id/orders/:order_id/request-removal
 * @access Private
 * @returns {Object} message
 */
Router.post(
  "/dispatches/:dispatch_id/orders/:order_id/request-removal",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateRemovalRequest(req, res);
    if (error) return;

    const { dispatch_id, order_id } = req.params;
    const { removal_reason } = req.body;

    // Check if dispatch and order entry exist
    const [dispatchOrder] = await connection.promise().query(
      /*sql*/ `
        SELECT do.*, d.dispatch_status, o.user_id, u.name AS user_name
        FROM warehouse_dispatch_orders do
        JOIN warehouse_dispatches d ON do.dispatch_id = d.dispatch_id
        JOIN orders o ON do.order_id = o.order_id
        JOIN users u ON o.user_id = u.user_id
        WHERE do.dispatch_id = ? AND do.order_id = ?
    `,
      [dispatch_id, order_id],
    );

    if (dispatchOrder.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Order not found in dispatch" });
    }

    if (dispatchOrder[0].dispatch_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot request removal from a dispatch with status '${dispatchOrder[0].dispatch_status}'`,
      });
    }

    // Mark as removal requested
    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_dispatch_orders
        SET removal_requested = 1, removal_reason = ?
        WHERE dispatch_id = ? AND order_id = ?
    `,
      [removal_reason, dispatch_id, order_id],
    );

    // Create a log entry
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description,
            metadata
        ) VALUES (?, ?, 'removal_requested', ?, ?)
    `,
      [
        dispatch_id,
        req.user.user_id,
        `Removal requested for Order #${order_id} (${dispatchOrder[0].user_name}): ${removal_reason}`,
        JSON.stringify({
          order_id,
          user_name: dispatchOrder[0].user_name,
          reason: removal_reason,
        }),
      ],
    );

    res.send({
      status: 200,
      message: `Removal requested for Order #${order_id}`,
    });
  }),
);

/**
 * Remove an order from a warehouse dispatch
 * @method DELETE
 * @url /api/warehouse/dispatches/:dispatch_id/orders/:order_id
 * @access Private
 * @returns {Object} message
 */
Router.delete(
  "/dispatches/:dispatch_id/orders/:order_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id, order_id } = req.params;

    // Check if dispatch and order entry exist
    const [dispatchOrder] = await connection.promise().query(
      /*sql*/ `
        SELECT do.*, d.dispatch_status, o.user_id, u.name AS user_name, do.removal_reason
        FROM warehouse_dispatch_orders do
        JOIN warehouse_dispatches d ON do.dispatch_id = d.dispatch_id
        JOIN orders o ON do.order_id = o.order_id
        JOIN users u ON o.user_id = u.user_id
        WHERE do.dispatch_id = ? AND do.order_id = ?
    `,
      [dispatch_id, order_id],
    );

    if (dispatchOrder.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Order not found in dispatch" });
    }

    if (dispatchOrder[0].dispatch_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot remove orders from a dispatch with status '${dispatchOrder[0].dispatch_status}'`,
      });
    }

    // Remove order from warehouse_dispatch_orders
    await connection.promise().query(
      /*sql*/ `
            DELETE FROM warehouse_dispatch_orders
            WHERE dispatch_id = ? AND order_id = ?
        `,
      [dispatch_id, order_id],
    );

    // Update total_orders count in the dispatch
    await connection.promise().query(
      /*sql*/ `
            UPDATE warehouse_dispatches 
            SET total_orders = total_orders - 1
            WHERE dispatch_id = ?
        `,
      [dispatch_id],
    );

    // Update or remove products from warehouse_dispatch_products
    await removeOrderProducts(dispatch_id, order_id);

    // Create a log entry
    const removalReason =
      dispatchOrder[0].removal_reason || "No reason provided";

    await connection.promise().query(
      /*sql*/ `
            INSERT INTO warehouse_dispatch_logs (
                dispatch_id, 
                user_id, 
                action, 
                description,
                metadata
            ) VALUES (?, ?, 'order_removed', ?, ?)
        `,
      [
        dispatch_id,
        req.user.user_id,
        `Order #${order_id} (${dispatchOrder[0].user_name}) removed from dispatch. Reason: ${removalReason}`,
        JSON.stringify({
          order_id,
          user_name: dispatchOrder[0].user_name,
          reason: removalReason,
        }),
      ],
    );

    res.send({
      status: 200,
      message: `Order #${order_id} successfully removed from dispatch`,
    });
  }),
);

/**
 * Update a warehouse dispatch (only for in_progress status)
 * @method PUT
 * @url /api/warehouse/dispatches/:dispatch_id
 * @access Private
 * @returns {Object} dispatch
 */
Router.put(
  "/dispatches/:dispatch_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateUpdateDispatchRequest(req, res);
    if (error) return;

    const { dispatch_id } = req.params;
    const { dispatch_date, notes, metadata } = req.body;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    const dispatch = dispatches[0];

    if (dispatch.dispatch_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot update a dispatch with status '${dispatch.dispatch_status}'`,
      });
    }

    // If changing the date, check if there's already a dispatch for that date
    if (
      dispatch_date &&
      moment(dispatch_date).format("YYYY-MM-DD") !==
        moment(dispatch.dispatch_date).format("YYYY-MM-DD")
    ) {
      const [existingDispatch] = await connection.promise().query(
        /*sql*/ `
            SELECT * FROM warehouse_dispatches 
            WHERE store_id = ? AND dispatch_date = ? AND dispatch_id != ?
        `,
        [
          dispatch.store_id,
          moment(dispatch_date).format("YYYY-MM-DD"),
          dispatch_id,
        ],
      );

      if (existingDispatch.length > 0) {
        return res.status(400).send({
          status: 400,
          message: "A dispatch already exists for this date.",
          dispatch_id: existingDispatch[0].dispatch_id,
        });
      }
    }

    // Build update object
    const updateData = {};
    if (dispatch_date)
      updateData.dispatch_date = moment(dispatch_date).format("YYYY-MM-DD");
    if (notes !== undefined) updateData.notes = notes;
    if (metadata !== undefined) updateData.metadata = JSON.stringify(metadata);
    updateData.updated_at = new Date();

    // Update the dispatch
    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_dispatches 
        SET ?
        WHERE dispatch_id = ?
    `,
      [updateData, dispatch_id],
    );

    // Create a log entry
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description
        ) VALUES (?, ?, 'updated', 'Dispatch details updated')
    `,
      [dispatch_id, req.user.user_id],
    );

    // Get the updated dispatch
    const [updatedDispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT d.*, 
               creator.name AS creator_name, 
               s.name AS store_name
        FROM warehouse_dispatches d
        JOIN store_admins creator ON d.created_by = creator.user_id
        JOIN stores s ON d.store_id = s.store_id
        WHERE d.dispatch_id = ?
    `,
      [dispatch_id],
    );

    res.send({
      status: 200,
      message: "Warehouse dispatch updated successfully",
      dispatch: updatedDispatches[0],
    });
  }),
);

/**
 * Finalize a warehouse dispatch - changes status from in_progress to finalized
 * @method PUT
 * @url /api/warehouse/dispatches/:dispatch_id/finalize
 * @access Private
 * @returns {Object} message
 */
Router.put(
  "/dispatches/:dispatch_id/finalize",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    const dispatch = dispatches[0];

    if (dispatch.dispatch_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot finalize a dispatch with status '${dispatch.dispatch_status}'`,
      });
    }

    // Check if there are orders with removal_requested that have not been processed
    const [pendingRemovals] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) as count 
        FROM warehouse_dispatch_orders 
        WHERE dispatch_id = ? AND removal_requested = 1
    `,
      [dispatch_id],
    );

    if (pendingRemovals[0].count > 0) {
      return res.status(400).send({
        status: 400,
        message: `Cannot finalize dispatch with ${pendingRemovals[0].count} pending removal requests. Please process all removal requests first.`,
      });
    }

    // Update the dispatch status to finalized
    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_dispatches 
        SET dispatch_status = 'finalized', 
            finalized_by = ?, 
            finalized_at = NOW(),
            updated_at = NOW()
        WHERE dispatch_id = ?
    `,
      [req.user.user_id, dispatch_id],
    );

    // Create a log entry
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description
        ) VALUES (?, ?, 'finalized', 'Dispatch finalized')
    `,
      [dispatch_id, req.user.user_id],
    );

    res.send({
      status: 200,
      message: "Dispatch finalized successfully",
    });
  }),
);

/**
 * Archive a warehouse dispatch - changes status from finalized to archived
 * @method PUT
 * @url /api/warehouse/dispatches/:dispatch_id/archive
 * @access Private
 * @returns {Object} message
 */
Router.put(
  "/dispatches/:dispatch_id/archive",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    const dispatch = dispatches[0];

    if (dispatch.dispatch_status !== "finalized") {
      return res.status(400).send({
        status: 400,
        message: `Only finalized dispatches can be archived. Current status: '${dispatch.dispatch_status}'`,
      });
    }

    // Update the dispatch status to archived
    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_dispatches 
        SET dispatch_status = 'archived', 
            updated_at = NOW()
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    // Create a log entry
    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description
        ) VALUES (?, ?, 'archived', 'Dispatch archived')
    `,
      [dispatch_id, req.user.user_id],
    );

    res.send({
      status: 200,
      message: "Dispatch archived successfully",
    });
  }),
);

/**
 * Get logs for a warehouse dispatch
 * @method GET
 * @url /api/warehouse/dispatches/:dispatch_id/logs
 * @access Private
 * @returns {Array} logs
 */
Router.get(
  "/dispatches/:dispatch_id/logs",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;
    const { page, limit, offset } = getPagination(req.query);

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    let sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    // Get logs with user names
    const [logs] = await connection.promise().query(
      /*sql*/ `
        SELECT dl.*, sa.name AS user_name
        FROM warehouse_dispatch_logs dl
        JOIN store_admins sa ON dl.user_id = sa.user_id
        WHERE dl.dispatch_id = ?
        ORDER BY dl.created_at DESC
        ${sqlLimit}
    `,
      [dispatch_id],
    );

    // Get total logs count for pagination
    const [totalLogs] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total FROM warehouse_dispatch_logs WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    res.send({
      status: 200,
      logs,
      total: totalLogs[0].total,
      page,
      limit,
      pages: Math.ceil(totalLogs[0].total / limit),
    });
  }),
);

/**
 * Create a log entry for a warehouse dispatch
 * @method POST
 * @url /api/warehouse/logs
 * @access Private
 * @returns {Object} log
 */
Router.post(
  "/logs",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateLogRequest(req, res);
    if (error) return;

    const { dispatch_id, action, description, metadata } = req.body;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    // Create the log entry
    const [result] = await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_dispatch_logs (
            dispatch_id, 
            user_id, 
            action, 
            description,
            metadata
        ) VALUES (?, ?, ?, ?, ?)
    `,
      [
        dispatch_id,
        req.user.user_id,
        action,
        description || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    // Get the created log with user name
    const [logs] = await connection.promise().query(
      /*sql*/ `
        SELECT dl.*, sa.name AS user_name
        FROM warehouse_dispatch_logs dl
        JOIN store_admins sa ON dl.user_id = sa.user_id
        WHERE dl.log_id = ?
    `,
      [result.insertId],
    );

    res.status(201).send({
      status: 201,
      message: "Log entry created successfully",
      log: logs[0],
    });
  }),
);

/**
 * Gets all orders in a warehouse dispatch
 * @method GET
 * @url /api/warehouse/dispatches/:dispatch_id/orders
 * @access Private
 * @returns {Array} orders
 */
Router.get(
  "/dispatches/:dispatch_id/orders",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;
    const { page, limit, offset } = getPagination(req.query);
    const { removal_requested } = req.query;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    let sqlWhere = " WHERE do.dispatch_id = ?";
    let sqlParams = [dispatch_id];

    if (removal_requested === "true") {
      sqlWhere += " AND do.removal_requested = 1";
    } else if (removal_requested === "false") {
      sqlWhere += " AND do.removal_requested = 0";
    }

    let sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    // Get orders with details
    const [orders] = await connection.promise().query(
      /*sql*/ `
        SELECT do.*, 
               o.order_status, o.fulfillment_status, o.grand_total, o.created_at AS order_created_at,
               o.shipping, o.tax, o.discount, o.address,
               u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
               adder.name AS added_by_name
        FROM warehouse_dispatch_orders do
        JOIN orders o ON do.order_id = o.order_id
        JOIN users u ON o.user_id = u.user_id
        JOIN store_admins adder ON do.added_by = adder.user_id
        ${sqlWhere}
        ORDER BY do.added_at DESC
        ${sqlLimit}
    `,
      sqlParams,
    );

    // Parse JSON fields
    // orders.forEach(order => {
    //     if (order.address) {
    //         order.address = JSON.parse(order.address);
    //     }
    // });

    // Get total orders count for pagination
    const [totalOrders] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total FROM warehouse_dispatch_orders do ${sqlWhere}
    `,
      sqlParams,
    );

    res.send({
      status: 200,
      orders,
      total: totalOrders[0].total,
      page,
      limit,
      pages: Math.ceil(totalOrders[0].total / limit),
    });
  }),
);

/**
 * Get product summary for a warehouse dispatch
 * @method GET
 * @url /api/warehouse/dispatches/:dispatch_id/products-summary
 * @access Private
 * @returns {Array} Product summary data in JSON format
 */
Router.get(
  "/dispatches/:dispatch_id/products-summary",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { dispatch_id } = req.params;

    // Check if dispatch exists
    const [dispatches] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_dispatches 
        WHERE dispatch_id = ?
    `,
      [dispatch_id],
    );

    if (dispatches.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Dispatch not found" });
    }

    // Get product summary data
    const [products] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            dp.dispatch_product_id,
            COALESCE(pvoc.sku_code, CONCAT('BUNDLE-', pb.product_bundle_id), 'N/A') AS sku,
            pvoc.variant_name,
            dp.name AS product_name,
            dp.quantity,
            dp.price,
            (dp.price * dp.quantity) AS total_value,
            p.product_id,
            pvoc.sku_id AS variant_id,
            pb.product_bundle_id AS bundle_id,
            COALESCE(pvoc.images, NULL) AS product_images
        FROM 
            warehouse_dispatch_products dp
        LEFT JOIN 
            products p ON dp.product_id = p.product_id
        LEFT JOIN 
            product_variant_option_combinations pvoc ON dp.variant_id = pvoc.sku_id
        LEFT JOIN 
            product_bundles pb ON dp.bundle_id = pb.product_bundle_id
        WHERE 
            dp.dispatch_id = ?
        ORDER BY 
            sku ASC
    `,
      [dispatch_id],
    );

    if (products.length === 0) {
      return res.send({
        status: 200,
        message: "No products found in this dispatch",
        summary: {
          products: [],
          totals: {
            quantity: 0,
            value: 0,
          },
        },
      });
    }

    // Process products data
    const formattedProducts = products.map((product) => {
      let images = [];

      // Parse images JSON if it exists
      if (product.product_images) {
        try {
          const parsedImages = product.product_images
            ?.split(",")
            .map((image) => image.trim());
          images = Array.isArray(parsedImages) ? parsedImages : [];
        } catch (e) {
          console.error("Error parsing product images:", e);
        }
      }

      return {
        dispatch_product_id: product.dispatch_product_id,
        sku: product.sku,
        product_name: product.product_name,
        variant_name: product.variant_name,
        quantity: product.quantity,
        price: product.price,
        total_value: product.total_value,
        product_id: product.product_id,
        variant_id: product.variant_id,
        bundle_id: product.bundle_id,
        thumbnail: images.length > 0 ? images[0] : null,
      };
    });

    // Calculate totals
    const totalQuantity = formattedProducts.reduce(
      (sum, product) => sum + product.quantity,
      0,
    );
    const totalValue = formattedProducts.reduce(
      (sum, product) => sum + product.total_value,
      0,
    );

    res.send({
      status: 200,
      summary: {
        products: formattedProducts,
        totals: {
          quantity: totalQuantity,
          value: totalValue,
        },
      },
    });
  }),
);

// ======================= WAREHOUSE RETURNS ROUTES =======================

/**
 * Create a new warehouse return batch
 * @method POST
 * @url /api/warehouse/returns
 * @access Private
 * @returns {Object} warehouse_return
 */
Router.post(
  "/returns",
  [auth, admin],
  limiter_10_1,
  asyncMiddleware(async (req, res) => {
    const error = validateCreateWarehouseReturnRequest(req, res);
    if (error) return;

    const { store_id, return_date, notes, metadata } = req.body;

    const [activeReturns] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id, return_status
        FROM warehouse_returns
        WHERE store_id = ? AND return_status IN ('in_progress', 'inspected')
        LIMIT 1
    `,
      [store_id],
    );

    if (activeReturns.length > 0) {
      return res.status(400).send({
        status: 400,
        message:
          "There is already an active return batch in progress for this store.",
        warehouse_return_id: activeReturns[0].warehouse_return_id,
        return_status: activeReturns[0].return_status,
      });
    }

    const [existingByDate] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id
        FROM warehouse_returns
        WHERE store_id = ? AND return_date = ?
        LIMIT 1
    `,
      [store_id, return_date],
    );

    if (existingByDate.length > 0) {
      return res.status(400).send({
        status: 400,
        message: "A return batch already exists for this date.",
        warehouse_return_id: existingByDate[0].warehouse_return_id,
      });
    }

    const [result] = await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_returns (
            store_id,
            return_date,
            return_status,
            created_by,
            notes,
            metadata
        ) VALUES (?, ?, 'in_progress', ?, ?, ?)
    `,
      [
        store_id,
        return_date,
        req.user.user_id,
        notes || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    const warehouse_return_id = result.insertId;

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description
        ) VALUES (?, ?, 'created', 'Return batch created')
    `,
      [warehouse_return_id, req.user.user_id],
    );

    const [warehouseReturn] = await connection.promise().query(
      /*sql*/ `
        SELECT wr.*,
               creator.name AS creator_name,
               finalizer.name AS finalizer_name,
               s.name AS store_name
        FROM warehouse_returns wr
        JOIN store_admins creator ON wr.created_by = creator.user_id
        LEFT JOIN store_admins finalizer ON wr.finalized_by = finalizer.user_id
        JOIN stores s ON wr.store_id = s.store_id
        WHERE wr.warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    res.status(201).send({
      status: 201,
      message: "Warehouse return created successfully",
      warehouse_return: warehouseReturn[0],
    });
  }),
);

/**
 * Get all warehouse returns with pagination and filtering
 * @method GET
 * @url /api/warehouse/returns
 * @access Private
 * @returns {Array} warehouse_returns
 */
Router.get(
  "/returns",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const { store_id, return_status, from_date, to_date, search } = req.query;

    if (!store_id) {
      return res
        .status(400)
        .send({ status: 400, message: "Store ID is required" });
    }

    let sqlWhere = " WHERE wr.store_id = ?";
    const sqlParams = [store_id];

    if (return_status) {
      sqlWhere += " AND wr.return_status = ?";
      sqlParams.push(return_status);
    }

    if (from_date) {
      sqlWhere += " AND wr.return_date >= ?";
      sqlParams.push(from_date);
    }

    if (to_date) {
      sqlWhere += " AND wr.return_date <= ?";
      sqlParams.push(to_date);
    }

    if (search) {
      sqlWhere += " AND (wr.warehouse_return_id LIKE ? OR wr.notes LIKE ?)";
      sqlParams.push(`%${search}%`, `%${search}%`);
    }

    const sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    const [returns] = await connection.promise().query(
      /*sql*/ `
        SELECT wr.*,
               creator.name AS creator_name,
               finalizer.name AS finalizer_name,
               s.name AS store_name
        FROM warehouse_returns wr
        JOIN store_admins creator ON wr.created_by = creator.user_id
        LEFT JOIN store_admins finalizer ON wr.finalized_by = finalizer.user_id
        JOIN stores s ON wr.store_id = s.store_id
        ${sqlWhere}
        ORDER BY wr.created_at DESC
        ${sqlLimit}
    `,
      sqlParams,
    );

    const getReturnProcessType = (row) => {
      const autoCount = Number(row.auto_count || 0);
      const customerCount = Number(row.customer_count || 0);
      const manualCount = Number(row.manual_count || 0);
      const totalCount = Number(row.total_count || 0);

      if (totalCount === 0) {
        return "other_processed";
      }

      if (
        autoCount >= customerCount &&
        autoCount >= manualCount &&
        autoCount > 0
      ) {
        return "auto_processed";
      }

      if (
        customerCount >= autoCount &&
        customerCount >= manualCount &&
        customerCount > 0
      ) {
        return "customer_processed";
      }

      if (manualCount > 0) {
        return "manual_processed";
      }

      return "other_processed";
    };

    if (returns.length > 0) {
      const returnIds = returns.map((item) => item.warehouse_return_id);

      const [processBreakdownRows] = await connection.promise().query(
        /*sql*/ `
          SELECT
            wro.warehouse_return_id,
            SUM(CASE WHEN o.auto_processed = 1 THEN 1 ELSE 0 END) AS auto_count,
            SUM(CASE
                  WHEN (o.auto_processed IS NULL OR o.auto_processed = 0)
                   AND o.process_type = 'customer_processed'
                  THEN 1 ELSE 0
                END) AS customer_count,
            SUM(CASE
                  WHEN o.order_id IS NOT NULL
                   AND (o.auto_processed IS NULL OR o.auto_processed = 0)
                   AND (o.process_type IS NULL OR o.process_type <> 'customer_processed')
                  THEN 1 ELSE 0
                END) AS manual_count,
            COUNT(o.order_id) AS total_count
          FROM warehouse_return_orders wro
          LEFT JOIN orders o ON wro.order_id = o.order_id
          WHERE wro.warehouse_return_id IN (?)
          GROUP BY wro.warehouse_return_id
      `,
        [returnIds],
      );

      const breakdownMap = new Map(
        processBreakdownRows.map((row) => [row.warehouse_return_id, row]),
      );

      returns.forEach((item) => {
        const breakdown =
          breakdownMap.get(item.warehouse_return_id) || {
            auto_count: 0,
            customer_count: 0,
            manual_count: 0,
            total_count: 0,
          };

        item.process_type = getReturnProcessType(breakdown);
        item.processing_breakdown = {
          auto_count: Number(breakdown.auto_count || 0),
          customer_count: Number(breakdown.customer_count || 0),
          manual_count: Number(breakdown.manual_count || 0),
          other_count: Math.max(
            Number(breakdown.total_count || 0) -
              Number(breakdown.auto_count || 0) -
              Number(breakdown.customer_count || 0) -
              Number(breakdown.manual_count || 0),
            0,
          ),
          total_count: Number(breakdown.total_count || 0),
        };
      });
    }

    const [totalResult] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total
        FROM warehouse_returns wr
        ${sqlWhere}
    `,
      sqlParams,
    );

    const [processingSummaryRows] = await connection.promise().query(
      /*sql*/ `
        SELECT
          SUM(CASE WHEN classified.process_type = 'auto_processed' THEN 1 ELSE 0 END) AS auto_processed,
          SUM(CASE WHEN classified.process_type = 'customer_processed' THEN 1 ELSE 0 END) AS customer_processed,
          SUM(CASE WHEN classified.process_type = 'manual_processed' THEN 1 ELSE 0 END) AS manual_processed,
          SUM(CASE WHEN classified.process_type = 'other_processed' THEN 1 ELSE 0 END) AS other_processed,
          COUNT(*) AS total_returns
        FROM (
          SELECT
            wr.warehouse_return_id,
            CASE
              WHEN COUNT(o.order_id) = 0 THEN 'other_processed'
              WHEN SUM(CASE WHEN o.auto_processed = 1 THEN 1 ELSE 0 END) >=
                   SUM(CASE
                         WHEN (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND o.process_type = 'customer_processed'
                         THEN 1 ELSE 0
                       END)
               AND SUM(CASE WHEN o.auto_processed = 1 THEN 1 ELSE 0 END) >=
                   SUM(CASE
                         WHEN o.order_id IS NOT NULL
                          AND (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND (o.process_type IS NULL OR o.process_type <> 'customer_processed')
                         THEN 1 ELSE 0
                       END)
               AND SUM(CASE WHEN o.auto_processed = 1 THEN 1 ELSE 0 END) > 0
              THEN 'auto_processed'
              WHEN SUM(CASE
                         WHEN (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND o.process_type = 'customer_processed'
                         THEN 1 ELSE 0
                       END) >= SUM(CASE WHEN o.auto_processed = 1 THEN 1 ELSE 0 END)
               AND SUM(CASE
                         WHEN (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND o.process_type = 'customer_processed'
                         THEN 1 ELSE 0
                       END) >= SUM(CASE
                                     WHEN o.order_id IS NOT NULL
                                      AND (o.auto_processed IS NULL OR o.auto_processed = 0)
                                      AND (o.process_type IS NULL OR o.process_type <> 'customer_processed')
                                     THEN 1 ELSE 0
                                   END)
               AND SUM(CASE
                         WHEN (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND o.process_type = 'customer_processed'
                         THEN 1 ELSE 0
                       END) > 0
              THEN 'customer_processed'
              WHEN SUM(CASE
                         WHEN o.order_id IS NOT NULL
                          AND (o.auto_processed IS NULL OR o.auto_processed = 0)
                          AND (o.process_type IS NULL OR o.process_type <> 'customer_processed')
                         THEN 1 ELSE 0
                       END) > 0
              THEN 'manual_processed'
              ELSE 'other_processed'
            END AS process_type
          FROM warehouse_returns wr
          LEFT JOIN warehouse_return_orders wro ON wr.warehouse_return_id = wro.warehouse_return_id
          LEFT JOIN orders o ON wro.order_id = o.order_id
          ${sqlWhere}
          GROUP BY wr.warehouse_return_id
        ) AS classified
    `,
      sqlParams,
    );

    const total = totalResult[0].total;
    const processingSummary = processingSummaryRows[0] || {};
    const totalProcessedReturns = Number(processingSummary.total_returns || 0);

    const processing_report = {
      auto_processed: Number(processingSummary.auto_processed || 0),
      customer_processed: Number(processingSummary.customer_processed || 0),
      manual_processed: Number(processingSummary.manual_processed || 0),
      agent_processed: Number(processingSummary.manual_processed || 0),
      other_processed: Number(processingSummary.other_processed || 0),
      total_returns: totalProcessedReturns,
      auto_percentage: totalProcessedReturns
        ? Number(
            ((Number(processingSummary.auto_processed || 0) /
              totalProcessedReturns) *
              100
            ).toFixed(2),
          )
        : 0,
      customer_percentage: totalProcessedReturns
        ? Number(
            ((Number(processingSummary.customer_processed || 0) /
              totalProcessedReturns) *
              100
            ).toFixed(2),
          )
        : 0,
      manual_percentage: totalProcessedReturns
        ? Number(
            ((Number(processingSummary.manual_processed || 0) /
              totalProcessedReturns) *
              100
            ).toFixed(2),
          )
        : 0,
      agent_percentage: totalProcessedReturns
        ? Number(
            ((Number(processingSummary.manual_processed || 0) /
              totalProcessedReturns) *
              100
            ).toFixed(2),
          )
        : 0,
      other_percentage: totalProcessedReturns
        ? Number(
            ((Number(processingSummary.other_processed || 0) /
              totalProcessedReturns) *
              100
            ).toFixed(2),
          )
        : 0,
    };

    res.send({
      status: 200,
      returns,
      processing_report,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  }),
);
/**
 * Get all warehouse returns with pagination and filtering
 * @method GET
 * @url /api/warehouse/returns/products
 * @access Private
 * @returns {Array} warehouse_returns
 */
Router.get(
  "/returns/products",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { from_date, to_date, store_id } = req.query;

    if (!store_id) {
      return res.status(400).send({
        status: 400,
        message: "Store ID is required",
      });
    }

    // Default to today's date in Dhaka (UTC+6) when from_date/to_date not provided
    const todayDhaka = moment()
      .add(DHAKA_TIMEZONE_OFFSET, "hours")
      .format("YYYY-MM-DD");
    const from = from_date || todayDhaka;
    const to = to_date || todayDhaka;

    let dateFilter = "";
    let params = [store_id];

    if (from && to) {
      dateFilter = "AND wr.return_date BETWEEN ? AND ?";
      params.push(from, to);
    }

    // Get product-wise return summary
    const [products] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            wrp.product_id,
            wrp.variant_id,
            wrp.bundle_id,
            wrp.name as product_name,
            COALESCE(pvoc.sku_code, CONCAT('BUNDLE-', pb.product_bundle_id), 'N/A') AS sku,
            pvoc.variant_name,
            SUM(wrp.expected_quantity) as total_expected,
            SUM(wrp.received_quantity) as total_received,
            SUM(wrp.accepted_quantity) as total_accepted,
            SUM(wrp.damaged_quantity) as total_damaged,
            SUM(wrp.missing_quantity) as total_missing,
            AVG(wrp.price) as avg_price,
            SUM(wrp.price * wrp.accepted_quantity) as total_value,
            COUNT(DISTINCT wrp.order_id) as order_count
        FROM warehouse_return_products wrp
        JOIN warehouse_returns wr ON wrp.warehouse_return_id = wr.warehouse_return_id
        LEFT JOIN product_variant_option_combinations pvoc ON wrp.variant_id = pvoc.sku_id
        LEFT JOIN product_bundles pb ON wrp.bundle_id = pb.product_bundle_id
        WHERE wr.store_id = ?
        ${dateFilter}
        GROUP BY 
            wrp.product_id,
            wrp.variant_id,
            wrp.bundle_id,
            wrp.name,
            pvoc.sku_code,
            pvoc.variant_name,
            pb.product_bundle_id,
            pvoc.images
        ORDER BY total_received DESC
    `,
      params,
    );

    // Get overall statistics
    const [totals] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            COUNT(DISTINCT wr.warehouse_return_id) as total_return_batches,
            COUNT(DISTINCT wrp.order_id) as total_orders,
            SUM(wrp.received_quantity) as total_items_received,
            SUM(wrp.accepted_quantity) as total_items_accepted,
            SUM(wrp.damaged_quantity) as total_items_damaged,
            SUM(wrp.missing_quantity) as total_items_missing,
            SUM(wrp.price * wrp.accepted_quantity) as total_value
        FROM warehouse_return_products wrp
        JOIN warehouse_returns wr ON wrp.warehouse_return_id = wr.warehouse_return_id
        WHERE wr.store_id = ?
        ${dateFilter}
    `,
      params,
    );

    // Format product data
    const formattedProducts = products.map((product) => {
      let images = [];
      if (product.product_images) {
        try {
          const parsedImages = product.product_images
            ?.split(",")
            .map((image) => image.trim());
          images = Array.isArray(parsedImages) ? parsedImages : [];
        } catch (e) {
          console.error("Error parsing product images:", e);
        }
      }

      return {
        product_id: product.product_id,
        variant_id: product.variant_id,
        bundle_id: product.bundle_id,
        sku: product.sku,
        product_name: product.product_name,
        variant_name: product.variant_name,
        total_expected: product.total_expected,
        total_received: product.total_received,
        total_accepted: product.total_accepted,
        total_damaged: product.total_damaged,
        total_missing: product.total_missing,
        avg_price: parseFloat(product.avg_price),
        total_value: parseFloat(product.total_value),
        order_count: product.order_count,
      };
    });

    res.send({
      status: 200,
      summary: {
        totals: {
          total_return_batches: totals[0].total_return_batches,
          total_orders: totals[0].total_orders,
          total_items_received: totals[0].total_items_received,
          total_items_accepted: totals[0].total_items_accepted,
          total_items_damaged: totals[0].total_items_damaged,
          total_items_missing: totals[0].total_items_missing,
          total_value: totals[0].total_value,
        },
        products: formattedProducts,
      },
    });
  }),
);

/**
 * Get a specific warehouse return by ID
 * @method GET
 * @url /api/warehouse/returns/:warehouse_return_id
 * @access Private
 * @returns {Object} warehouse_return
 */
Router.get(
  "/returns/:warehouse_return_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;
    const { with_orders, with_products, with_logs } = req.query;

    const [returns] = await connection.promise().query(
      /*sql*/ `
        SELECT wr.*,
               creator.name AS creator_name,
               finalizer.name AS finalizer_name,
               s.name AS store_name
        FROM warehouse_returns wr
        JOIN store_admins creator ON wr.created_by = creator.user_id
        LEFT JOIN store_admins finalizer ON wr.finalized_by = finalizer.user_id
        JOIN stores s ON wr.store_id = s.store_id
        WHERE wr.warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returns.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const warehouseReturn = returns[0];

    if (with_orders === "true") {
      const [orders] = await connection.promise().query(
        /*sql*/ `
            SELECT wro.*,
                   o.order_status,
                   o.fulfillment_status,
                   o.grand_total,
                   o.created_at AS order_created_at,
                   u.name AS user_name,
                   u.phone AS user_phone,
                   u.email AS user_email,
                   r.return_status AS linked_return_status,
                   adder.name AS added_by_name
            FROM warehouse_return_orders wro
            JOIN orders o ON wro.order_id = o.order_id
            JOIN users u ON o.user_id = u.user_id
            JOIN store_admins adder ON wro.added_by = adder.user_id
            LEFT JOIN returns r ON wro.return_id = r.return_id
            WHERE wro.warehouse_return_id = ?
            ORDER BY wro.added_at DESC
        `,
        [warehouse_return_id],
      );

      warehouseReturn.orders = orders;
    }

    if (with_products === "true") {
      const [products] = await connection.promise().query(
        /*sql*/ `
            SELECT *
            FROM warehouse_return_products
            WHERE warehouse_return_id = ?
            ORDER BY created_at DESC
        `,
        [warehouse_return_id],
      );

      warehouseReturn.products = products;
    }

    if (with_logs === "true") {
      const [logs] = await connection.promise().query(
        /*sql*/ `
            SELECT wrl.*, sa.name AS user_name
            FROM warehouse_return_logs wrl
            JOIN store_admins sa ON wrl.user_id = sa.user_id
            WHERE wrl.warehouse_return_id = ?
            ORDER BY wrl.created_at DESC
        `,
        [warehouse_return_id],
      );

      warehouseReturn.logs = logs;
    }

    res.send({
      status: 200,
      warehouse_return: warehouseReturn,
    });
  }),
);

/**
 * Add an order to a warehouse return batch
 * @method POST
 * @url /api/warehouse/returns/orders
 * @access Private
 * @returns {Object} message
 */
Router.post(
  "/returns/orders",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateAddReturnOrderRequest(req, res);
    if (error) return;

    const { warehouse_return_id, order_id, return_id, notes, items } = req.body;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const returnBatch = returnBatchRows[0];

    if (returnBatch.return_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot add orders to a return batch with status '${returnBatch.return_status}'`,
      });
    }

    const [orderRows] = await connection.promise().query(
      /*sql*/ `
        SELECT o.*, u.name AS user_name, u.phone AS user_phone
        FROM orders o
        JOIN users u ON o.user_id = u.user_id
        WHERE o.order_id = ?
    `,
      [order_id],
    );

    if (orderRows.length === 0) {
      return res.status(404).send({ status: 404, message: "Order not found" });
    }

    const orderRecord = orderRows[0];

    if (orderRecord.store_id !== returnBatch.store_id) {
      return res.status(400).send({
        status: 400,
        message: "Order does not belong to the same store as the return batch",
      });
    }

    const [dispatchCheck] = await connection.promise().query(
      /*sql*/ `
        SELECT dispatch_id FROM warehouse_dispatch_orders WHERE order_id = ? LIMIT 1
    `,
      [order_id],
    );

    if (dispatchCheck.length === 0) {
      return res.status(400).send({
        status: 400,
        message:
          "Order has not been dispatched and cannot be added to a return batch",
      });
    }

    const [existingOrder] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_order_id
        FROM warehouse_return_orders
        WHERE warehouse_return_id = ? AND order_id = ?
    `,
      [warehouse_return_id, order_id],
    );

    if (existingOrder.length > 0) {
      return res.status(400).send({
        status: 400,
        message: "Order is already part of this return batch",
      });
    }

    if (return_id) {
      const [linkedReturns] = await connection.promise().query(
        /*sql*/ `
            SELECT return_id, order_id, return_status
            FROM returns
            WHERE return_id = ?
        `,
        [return_id],
      );

      if (linkedReturns.length === 0) {
        return res.status(404).send({
          status: 404,
          message: "Linked return record not found",
        });
      }

      if (linkedReturns[0].order_id !== order_id) {
        return res.status(400).send({
          status: 400,
          message: "Linked return record does not belong to the provided order",
        });
      }
    }

    for (const item of items) {
      const expectedQuantity = item.expected_quantity;
      const receivedQuantity = item.received_quantity;
      const acceptedQuantity = item.accepted_quantity;
      const damagedQuantity = item.damaged_quantity;

      if (acceptedQuantity + damagedQuantity > receivedQuantity) {
        return res.status(400).send({
          status: 400,
          message:
            "Accepted quantity plus damaged quantity cannot exceed received quantity",
        });
      }
    }

    const [insertOrderResult] = await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_orders (
            warehouse_return_id,
            order_id,
            return_id,
            added_by,
            notes
        ) VALUES (?, ?, ?, ?, ?)
    `,
      [
        warehouse_return_id,
        order_id,
        return_id || null,
        req.user.user_id,
        notes || null,
      ],
    );

    const warehouse_return_order_id = insertOrderResult.insertId;

    await processReturnProducts(
      warehouse_return_id,
      warehouse_return_order_id,
      order_id,
      items,
    );

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET total_orders = total_orders + 1,
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description,
            metadata
        ) VALUES (?, ?, 'order_added', ?, ?)
    `,
      [
        warehouse_return_id,
        req.user.user_id,
        `Order #${order_id} (${orderRecord.user_name}) added to return batch`,
        JSON.stringify({
          order_id,
          user_name: orderRecord.user_name,
          total_items: items.reduce(
            (sum, item) => sum + item.received_quantity,
            0,
          ),
          damaged_items: items.reduce(
            (sum, item) => sum + item.damaged_quantity,
            0,
          ),
        }),
      ],
    );

    res.send({
      status: 200,
      message: `Order #${order_id} successfully added to return batch`,
      warehouse_return_order_id,
    });
  }),
);

/**
 * Remove an order from a warehouse return batch
 * @method DELETE
 * @url /api/warehouse/returns/:warehouse_return_id/orders/:order_id
 * @access Private
 * @returns {Object} message
 */
Router.delete(
  "/returns/:warehouse_return_id/orders/:order_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id, order_id } = req.params;

    const [returnOrderRows] = await connection.promise().query(
      /*sql*/ `
        SELECT wro.*, wr.return_status, u.name AS user_name
        FROM warehouse_return_orders wro
        JOIN warehouse_returns wr ON wro.warehouse_return_id = wr.warehouse_return_id
        JOIN orders o ON wro.order_id = o.order_id
        JOIN users u ON o.user_id = u.user_id
        WHERE wro.warehouse_return_id = ? AND wro.order_id = ?
    `,
      [warehouse_return_id, order_id],
    );

    if (returnOrderRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Order not found in return batch" });
    }

    const returnOrder = returnOrderRows[0];

    if (returnOrder.return_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Cannot remove orders from a return batch with status '${returnOrder.return_status}'`,
      });
    }

    await connection.promise().query(
      /*sql*/ `
        DELETE FROM warehouse_return_orders
        WHERE warehouse_return_order_id = ?
    `,
      [returnOrder.warehouse_return_order_id],
    );

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET total_orders = GREATEST(total_orders - 1, 0),
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    await updateWarehouseReturnTotals(warehouse_return_id);

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description,
            metadata
        ) VALUES (?, ?, 'order_removed', ?, ?)
    `,
      [
        warehouse_return_id,
        req.user.user_id,
        `Order #${order_id} (${returnOrder.user_name}) removed from return batch`,
        JSON.stringify({
          order_id,
          user_name: returnOrder.user_name,
        }),
      ],
    );

    res.send({
      status: 200,
      message: `Order #${order_id} removed from return batch`,
    });
  }),
);

/**
 * Update a warehouse return batch (only for in_progress status)
 * @method PUT
 * @url /api/warehouse/returns/:warehouse_return_id
 * @access Private
 * @returns {Object} warehouse_return
 */
Router.put(
  "/returns/:warehouse_return_id",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateUpdateWarehouseReturnRequest(req, res);
    if (error) return;

    const { warehouse_return_id } = req.params;
    const { return_date, notes, metadata } = req.body;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const returnBatch = returnBatchRows[0];

    if (returnBatch.return_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Only return batches with status 'in_progress' can be updated. Current status: '${returnBatch.return_status}'`,
      });
    }

    const updates = [];
    const params = [];

    if (return_date) {
      updates.push("return_date = ?");
      params.push(return_date);
    }

    if (notes !== undefined) {
      updates.push("notes = ?");
      params.push(notes || null);
    }

    if (metadata !== undefined) {
      updates.push("metadata = ?");
      params.push(metadata ? JSON.stringify(metadata) : null);
    }

    if (updates.length === 0) {
      return res.status(400).send({
        status: 400,
        message: "No valid fields provided to update",
      });
    }

    updates.push("updated_at = NOW()");

    params.push(warehouse_return_id);

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET ${updates.join(", ")}
        WHERE warehouse_return_id = ?
    `,
      params,
    );

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description
        ) VALUES (?, ?, 'updated', 'Return batch updated')
    `,
      [warehouse_return_id, req.user.user_id],
    );

    const [updatedReturn] = await connection.promise().query(
      /*sql*/ `
        SELECT wr.*,
               creator.name AS creator_name,
               s.name AS store_name
        FROM warehouse_returns wr
        JOIN store_admins creator ON wr.created_by = creator.user_id
        JOIN stores s ON wr.store_id = s.store_id
        WHERE wr.warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    res.send({
      status: 200,
      message: "Warehouse return updated successfully",
      warehouse_return: updatedReturn[0],
    });
  }),
);

/**
 * Mark a warehouse return batch as inspected
 * @method PUT
 * @url /api/warehouse/returns/:warehouse_return_id/inspect
 * @access Private
 * @returns {Object} message
 */
Router.put(
  "/returns/:warehouse_return_id/inspect",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const returnBatch = returnBatchRows[0];

    if (returnBatch.return_status !== "in_progress") {
      return res.status(400).send({
        status: 400,
        message: `Only return batches with status 'in_progress' can be inspected. Current status: '${returnBatch.return_status}'`,
      });
    }

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET return_status = 'inspected',
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description
        ) VALUES (?, ?, 'inspected', 'Return batch inspected')
    `,
      [warehouse_return_id, req.user.user_id],
    );

    res.send({
      status: 200,
      message: "Return batch marked as inspected",
    });
  }),
);

/**
 * Finalize a warehouse return batch
 * @method PUT
 * @url /api/warehouse/returns/:warehouse_return_id/finalize
 * @access Private
 * @returns {Object} message
 */
Router.put(
  "/returns/:warehouse_return_id/finalize",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const returnBatch = returnBatchRows[0];

    if (returnBatch.return_status !== "inspected") {
      return res.status(400).send({
        status: 400,
        message: `Only inspected return batches can be finalized. Current status: '${returnBatch.return_status}'`,
      });
    }

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET return_status = 'finalized',
            finalized_by = ?,
            finalized_at = NOW(),
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
      [req.user.user_id, warehouse_return_id],
    );

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description
        ) VALUES (?, ?, 'finalized', 'Return batch finalized')
    `,
      [warehouse_return_id, req.user.user_id],
    );

    res.send({
      status: 200,
      message: "Return batch finalized successfully",
    });
  }),
);

/**
 * Archive a warehouse return batch
 * @method PUT
 * @url /api/warehouse/returns/:warehouse_return_id/archive
 * @access Private
 * @returns {Object} message
 */
Router.put(
  "/returns/:warehouse_return_id/archive",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT * FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const returnBatch = returnBatchRows[0];

    if (returnBatch.return_status !== "finalized") {
      return res.status(400).send({
        status: 400,
        message: `Only finalized return batches can be archived. Current status: '${returnBatch.return_status}'`,
      });
    }

    await connection.promise().query(
      /*sql*/ `
        UPDATE warehouse_returns
        SET return_status = 'archived',
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description
        ) VALUES (?, ?, 'archived', 'Return batch archived')
    `,
      [warehouse_return_id, req.user.user_id],
    );

    res.send({
      status: 200,
      message: "Return batch archived successfully",
    });
  }),
);

/**
 * Get logs for a warehouse return batch
 * @method GET
 * @url /api/warehouse/returns/:warehouse_return_id/logs
 * @access Private
 * @returns {Array} logs
 */
Router.get(
  "/returns/:warehouse_return_id/logs",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;
    const { page, limit, offset } = getPagination(req.query);

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    const [logs] = await connection.promise().query(
      /*sql*/ `
        SELECT wrl.*, sa.name AS user_name
        FROM warehouse_return_logs wrl
        JOIN store_admins sa ON wrl.user_id = sa.user_id
        WHERE wrl.warehouse_return_id = ?
        ORDER BY wrl.created_at DESC
        ${sqlLimit}
    `,
      [warehouse_return_id],
    );

    const [totalLogs] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total FROM warehouse_return_logs WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    res.send({
      status: 200,
      logs,
      total: totalLogs[0].total,
      page,
      limit,
      pages: Math.ceil(totalLogs[0].total / limit),
    });
  }),
);

/**
 * Create a log entry for a warehouse return batch
 * @method POST
 * @url /api/warehouse/returns/logs
 * @access Private
 * @returns {Object} log
 */
Router.post(
  "/returns/logs",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const error = validateReturnLogRequest(req, res);
    if (error) return;

    const { warehouse_return_id, action, description, metadata } = req.body;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const [result] = await connection.promise().query(
      /*sql*/ `
        INSERT INTO warehouse_return_logs (
            warehouse_return_id,
            user_id,
            action,
            description,
            metadata
        ) VALUES (?, ?, ?, ?, ?)
    `,
      [
        warehouse_return_id,
        req.user.user_id,
        action,
        description || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    const [logs] = await connection.promise().query(
      /*sql*/ `
        SELECT wrl.*, sa.name AS user_name
        FROM warehouse_return_logs wrl
        JOIN store_admins sa ON wrl.user_id = sa.user_id
        WHERE wrl.warehouse_return_log_id = ?
    `,
      [result.insertId],
    );

    res.status(201).send({
      status: 201,
      message: "Return log entry created successfully",
      log: logs[0],
    });
  }),
);

/**
 * Get all orders in a warehouse return batch
 * @method GET
 * @url /api/warehouse/returns/:warehouse_return_id/orders
 * @access Private
 * @returns {Array} orders
 */
Router.get(
  "/returns/:warehouse_return_id/orders",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;
    const { page, limit, offset } = getPagination(req.query);

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const sqlLimit = limit ? ` LIMIT ${limit} OFFSET ${offset}` : "";

    const [orders] = await connection.promise().query(
      /*sql*/ `
        SELECT wro.*,
               o.order_status,
               o.fulfillment_status,
               o.grand_total,
               o.created_at AS order_created_at,
               u.name AS user_name,
               u.phone AS user_phone,
               u.email AS user_email,
               r.return_status AS linked_return_status,
               adder.name AS added_by_name
        FROM warehouse_return_orders wro
        JOIN orders o ON wro.order_id = o.order_id
        JOIN users u ON o.user_id = u.user_id
        JOIN store_admins adder ON wro.added_by = adder.user_id
        LEFT JOIN returns r ON wro.return_id = r.return_id
        WHERE wro.warehouse_return_id = ?
        ORDER BY wro.added_at DESC
        ${sqlLimit}
    `,
      [warehouse_return_id],
    );

    const [totalOrders] = await connection.promise().query(
      /*sql*/ `
        SELECT COUNT(*) AS total
        FROM warehouse_return_orders
        WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    res.send({
      status: 200,
      orders,
      total: totalOrders[0].total,
      page,
      limit,
      pages: Math.ceil(totalOrders[0].total / limit),
    });
  }),
);

/**
 * Get product summary for a warehouse return batch
 * @method GET
 * @url /api/warehouse/returns/:warehouse_return_id/products-summary
 * @access Private
 * @returns {Array} Product summary data in JSON format
 */
Router.get(
  "/returns/:warehouse_return_id/products-summary",
  [auth, admin],
  asyncMiddleware(async (req, res) => {
    const { warehouse_return_id } = req.params;

    const [returnBatchRows] = await connection.promise().query(
      /*sql*/ `
        SELECT warehouse_return_id FROM warehouse_returns WHERE warehouse_return_id = ?
    `,
      [warehouse_return_id],
    );

    if (returnBatchRows.length === 0) {
      return res
        .status(404)
        .send({ status: 404, message: "Warehouse return not found" });
    }

    const [products] = await connection.promise().query(
      /*sql*/ `
        SELECT 
            rp.warehouse_return_product_id,
            rp.order_id,
            COALESCE(pvoc.sku_code, CONCAT('BUNDLE-', pb.product_bundle_id), 'N/A') AS sku,
            pvoc.variant_name,
            rp.name AS product_name,
            rp.expected_quantity,
            rp.received_quantity,
            rp.accepted_quantity,
            rp.damaged_quantity,
            rp.missing_quantity,
            rp.price,
            (rp.price * rp.accepted_quantity) AS total_value,
            rp.product_id,
            rp.variant_id,
            rp.bundle_id,
            COALESCE(pvoc.images, NULL) AS product_images
        FROM warehouse_return_products rp
        LEFT JOIN products p ON rp.product_id = p.product_id
        LEFT JOIN product_variant_option_combinations pvoc ON rp.variant_id = pvoc.sku_id
        LEFT JOIN product_bundles pb ON rp.bundle_id = pb.product_bundle_id
        WHERE rp.warehouse_return_id = ?
        ORDER BY sku ASC
    `,
      [warehouse_return_id],
    );

    if (products.length === 0) {
      return res.send({
        status: 200,
        message: "No products found in this return batch",
        summary: {
          products: [],
          totals: {
            expected: 0,
            received: 0,
            accepted: 0,
            damaged: 0,
            missing: 0,
            value: 0,
          },
        },
      });
    }

    const formattedProducts = products.map((product) => {
      let images = [];

      if (product.product_images) {
        try {
          const parsedImages = product.product_images
            ?.split(",")
            .map((image) => image.trim());
          images = Array.isArray(parsedImages) ? parsedImages : [];
        } catch (e) {
          console.error("Error parsing product images:", e);
        }
      }

      return {
        warehouse_return_product_id: product.warehouse_return_product_id,
        order_id: product.order_id,
        sku: product.sku,
        product_name: product.product_name,
        variant_name: product.variant_name,
        expected_quantity: product.expected_quantity,
        received_quantity: product.received_quantity,
        accepted_quantity: product.accepted_quantity,
        damaged_quantity: product.damaged_quantity,
        missing_quantity: product.missing_quantity,
        price: product.price,
        total_value: product.total_value,
        product_id: product.product_id,
        variant_id: product.variant_id,
        bundle_id: product.bundle_id,
        thumbnail: images.length > 0 ? images[0] : null,
      };
    });

    const totals = formattedProducts.reduce(
      (acc, product) => {
        acc.expected += product.expected_quantity;
        acc.received += product.received_quantity;
        acc.accepted += product.accepted_quantity;
        acc.damaged += product.damaged_quantity;
        acc.missing += product.missing_quantity;
        acc.value += product.total_value;
        return acc;
      },
      {
        expected: 0,
        received: 0,
        accepted: 0,
        damaged: 0,
        missing: 0,
        value: 0,
      },
    );

    res.send({
      status: 200,
      summary: {
        products: formattedProducts,
        totals,
      },
    });
  }),
);

/**
 * Process the products from an order and update dispatch_products
 * @param {number} dispatch_id - The dispatch ID
 * @param {number} order_id - The order ID
 */
async function processOrderProducts(dispatch_id, order_id) {
  // Get all items from the order
  const [orderItems] = await connection.promise().query(
    /*sql*/ `
        SELECT * FROM order_items WHERE order_id = ?
    `,
    [order_id],
  );

  // Begin transaction
  // await connection.promise().query('START TRANSACTION');

  try {
    // Process each item
    for (const item of orderItems) {
      const { product_id, variant_id, bundle_id, name, price, quantity } = item;

      // Check if the product already exists in the dispatch
      const [existingProducts] = await connection.promise().query(
        /*sql*/ `
                SELECT * FROM warehouse_dispatch_products 
                WHERE dispatch_id = ? 
                AND product_id ${product_id ? "= ?" : "IS NULL"}
                AND variant_id ${variant_id ? "= ?" : "IS NULL"}
                AND bundle_id ${bundle_id ? "= ?" : "IS NULL"}
            `,
        [
          dispatch_id,
          ...(product_id ? [product_id] : []),
          ...(variant_id ? [variant_id] : []),
          ...(bundle_id ? [bundle_id] : []),
        ],
      );

      if (existingProducts.length > 0) {
        // Update existing product quantity
        await connection.promise().query(
          /*sql*/ `
                    UPDATE warehouse_dispatch_products
                    SET quantity = quantity + ?,
                        price = ?
                    WHERE dispatch_product_id = ?
                `,
          [quantity, price, existingProducts[0].dispatch_product_id],
        );
      } else {
        // Add new product entry
        await connection.promise().query(
          /*sql*/ `
                    INSERT INTO warehouse_dispatch_products (
                        dispatch_id, 
                        product_id, 
                        variant_id, 
                        bundle_id, 
                        name, 
                        price, 
                        quantity
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `,
          [
            dispatch_id,
            product_id || null,
            variant_id || null,
            bundle_id || null,
            name,
            price,
            quantity,
          ],
        );
      }
    }

    // Update total items and value in the dispatch
    await updateDispatchTotals(dispatch_id);

    // Commit transaction
    // await connection.promise().query('COMMIT');
  } catch (error) {
    // Rollback transaction on error
    // await connection.promise().query('ROLLBACK');
    throw error;
  }
}

/**
 * Remove products added from a specific order from the dispatch
 * @param {number} dispatch_id - The dispatch ID
 * @param {number} order_id - The order ID
 */
async function removeOrderProducts(dispatch_id, order_id) {
  // Get all items from the order
  const [orderItems] = await connection.promise().query(
    /*sql*/ `
        SELECT * FROM order_items WHERE order_id = ?
    `,
    [order_id],
  );

  for (const item of orderItems) {
    const { product_id, variant_id, bundle_id, quantity } = item;

    // Find the product in dispatch_products
    const [existingProducts] = await connection.promise().query(
      /*sql*/ `
                SELECT * FROM warehouse_dispatch_products 
                WHERE dispatch_id = ? 
                AND product_id ${product_id ? "= ?" : "IS NULL"}
                AND variant_id ${variant_id ? "= ?" : "IS NULL"}
                AND bundle_id ${bundle_id ? "= ?" : "IS NULL"}
            `,
      [
        dispatch_id,
        ...(product_id ? [product_id] : []),
        ...(variant_id ? [variant_id] : []),
        ...(bundle_id ? [bundle_id] : []),
      ],
    );

    if (existingProducts.length > 0) {
      const product = existingProducts[0];
      const newQuantity = product.quantity - quantity;

      if (newQuantity <= 0) {
        // Remove product entry if quantity would be zero or negative
        await connection.promise().query(
          /*sql*/ `
                        DELETE FROM warehouse_dispatch_products
                        WHERE dispatch_product_id = ?
                    `,
          [product.dispatch_product_id],
        );
      } else {
        // Update existing product quantity
        await connection.promise().query(
          /*sql*/ `
                        UPDATE warehouse_dispatch_products
                        SET quantity = ?
                        WHERE dispatch_product_id = ?
                    `,
          [newQuantity, product.dispatch_product_id],
        );
      }
    }
  }

  // Update total items and value in the dispatch
  await updateDispatchTotals(dispatch_id);
}

/**
 * Update the total_items and total_value in a dispatch based on the products
 * @param {number} dispatch_id - The dispatch ID
 */
async function updateDispatchTotals(dispatch_id) {
  // Calculate total items (sum of all quantities)
  const [itemsResult] = await connection.promise().query(
    /*sql*/ `
        SELECT SUM(quantity) AS total_items
        FROM warehouse_dispatch_products
        WHERE dispatch_id = ?
    `,
    [dispatch_id],
  );

  // Calculate total value (sum of price * quantity for all products)
  const [valueResult] = await connection.promise().query(
    /*sql*/ `
        SELECT SUM(price * quantity) AS total_value
        FROM warehouse_dispatch_products
        WHERE dispatch_id = ?
    `,
    [dispatch_id],
  );

  const totalItems = itemsResult[0].total_items || 0;
  const totalValue = valueResult[0].total_value || 0;

  // Update the dispatch
  await connection.promise().query(
    /*sql*/ `
        UPDATE warehouse_dispatches
        SET total_items = ?,
            total_value = ?
        WHERE dispatch_id = ?
    `,
    [totalItems, totalValue, dispatch_id],
  );
}

/**
 * Process return items for an order and update warehouse_return_products
 * @param {number} warehouse_return_id - The warehouse return ID
 * @param {number} warehouse_return_order_id - The warehouse return order ID
 * @param {number} order_id - The order ID
 * @param {Array} items - Items being returned
 */
async function processReturnProducts(
  warehouse_return_id,
  warehouse_return_order_id,
  order_id,
  items,
) {
  for (const item of items) {
    let {
      order_item_id,
      product_id,
      variant_id,
      bundle_id,
      name,
      price,
      expected_quantity,
      received_quantity,
      accepted_quantity,
      damaged_quantity,
      missing_quantity,
      condition,
      damage_notes,
      metadata,
    } = item;

    const normalizedExpected = Number(expected_quantity) || 0;
    const normalizedReceived = Number(received_quantity) || 0;
    const normalizedAccepted = Number(accepted_quantity) || 0;
    const normalizedDamaged = Number(damaged_quantity) || 0;
    const normalizedMissing =
      typeof missing_quantity === "number"
        ? Math.max(Number(missing_quantity), 0)
        : Math.max(normalizedExpected - normalizedReceived, 0);
    const normalizedPrice = Number(price) || 0;

    await connection.promise().query(
      /*sql*/ `
            INSERT INTO warehouse_return_products (
                warehouse_return_id,
                warehouse_return_order_id,
                order_id,
                order_item_id,
                product_id,
                variant_id,
                bundle_id,
                name,
                price,
                expected_quantity,
                received_quantity,
                accepted_quantity,
                damaged_quantity,
                missing_quantity,
                \`condition\`,
                damage_notes,
                metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      [
        warehouse_return_id,
        warehouse_return_order_id,
        order_id,
        order_item_id || null,
        product_id || null,
        variant_id || null,
        bundle_id || null,
        name,
        normalizedPrice,
        normalizedExpected,
        normalizedReceived,
        normalizedAccepted,
        normalizedDamaged,
        normalizedMissing,
        condition || null,
        damage_notes || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  await updateWarehouseReturnTotals(warehouse_return_id);
}

/**
 * Update aggregate totals for a warehouse return batch
 * @param {number} warehouse_return_id - The warehouse return ID
 */
async function updateWarehouseReturnTotals(warehouse_return_id) {
  const [totalsResult] = await connection.promise().query(
    /*sql*/ `
        SELECT 
            COALESCE(SUM(received_quantity), 0) AS total_received,
            COALESCE(SUM(accepted_quantity), 0) AS total_accepted,
            COALESCE(SUM(damaged_quantity), 0) AS total_damaged,
            COALESCE(SUM(missing_quantity), 0) AS total_missing,
            COALESCE(SUM(price * accepted_quantity), 0) AS total_value
        FROM warehouse_return_products
        WHERE warehouse_return_id = ?
    `,
    [warehouse_return_id],
  );

  const totals = totalsResult[0] || {};

  await connection.promise().query(
    /*sql*/ `
        UPDATE warehouse_returns
        SET total_items = ?,
            total_value = ?,
            total_damaged_items = ?,
            total_missing_items = ?,
            updated_at = NOW()
        WHERE warehouse_return_id = ?
    `,
    [
      totals.total_received || 0,
      totals.total_value || 0,
      totals.total_damaged || 0,
      totals.total_missing || 0,
      warehouse_return_id,
    ],
  );
}

const startWarehouseScheduler = () => {
  // Reset printed count for dispatch orders every day at midnight
  cron.schedule(
    "0 0 * * *",
    async () => {
      try {
        console.log(
          "Running warehouse dispatch orders printed reset scheduler...",
        );
        await connection.promise().query(
          /*sql*/ `
      UPDATE orders o
      SET o.printed = 0
      WHERE o.store_id = ?
        AND o.printed > 0
        AND NOT EXISTS (
          SELECT order_id
          FROM warehouse_dispatch_orders wdo
          WHERE wdo.order_id = o.order_id
        )
    `,
          [2],
        );
        console.log(
          "Warehouse dispatch orders printed count reset successfully.",
        );
      } catch (error) {
        console.error(
          "Error resetting warehouse dispatch orders printed count:",
          error,
        );
      }
    },
    {
      timezone: "Asia/Dhaka",
    },
  );
};

module.exports = Router;
module.exports.startWarehouseScheduler = startWarehouseScheduler;
