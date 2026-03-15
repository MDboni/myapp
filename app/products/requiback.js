/**
 * @route /api/requisitions
 * POS Requisition System with Multi-step Approval Workflow
 */
const express = require('express');
const Router = express.Router();
const { connection } = require('../startup/db');
const asyncMiddleware = require('../middlewares/asyncMiddleware');
const auth = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');

const {
    generateRequisitionNo,
    validateCreateRequisition,
    validateUpdateRequisition,
    validateCallCenterApproval,
    validateFactoryInchargeApproval,
    validateFactoryTeamAssignment,
    validatePosReceipt,
    canEditRequisition,
    validateQuantities,
    createAuditLog,
    updateInventoryOnDelivery,
    getRequisitionWithDetails,
    checkRequisitionAuthorization,
    RequisitionStatuses
} = require('../models/requisition');

const { getPagination } = require('../utils/helpers');

/**
 * CREATE: Initiate a new requisition
 * POST /api/requisitions
 * Access: POS Staff
 * Initial Status: call_center_manager_status & pos_received_status = 'pending'
 */
Router.post(
    '/',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('📋 Creating new requisition');
        const error = validateCreateRequisition(req, res);
        if (error) return;

        const conn = connection;
        try {
            // Start transaction
            await conn.promise().query('START TRANSACTION');

            const { pos_id, pos_remark, items } = req.body;
            const userId = req.user.user_id;

            // Generate unique requisition number
            const requisition_no = await generateRequisitionNo();

            // Calculate total quantity
            const total_quantity = items.reduce((sum, item) => sum + item.requested_quantity, 0);

            // Insert requisition master record
            const [result] = await conn.promise().query(
                `INSERT INTO requisitions 
         (requisition_no, pos_id, total_quantity, pos_remark, requisition_sender_id,
          call_center_manager_status, factory_incharge_status, factory_team_assign_status, pos_received_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    requisition_no,
                    pos_id,
                    total_quantity,
                    pos_remark || null,
                    userId,
                    RequisitionStatuses.CALL_CENTER.PENDING,
                    RequisitionStatuses.FACTORY_INCHARGE.PENDING,
                    RequisitionStatuses.FACTORY_TEAM.PENDING,
                    RequisitionStatuses.POS_RECEIVED.PENDING
                ]
            );

            const requisition_id = result.insertId;

            // Insert requisition items
            const itemsData = items.map((item) => [
                requisition_id,
                item.product_id,
                item.product_name,
                item.variant_id,
                item.variant_name,
                item.requested_quantity,
                0, // factory_send_quantity
                0  // pos_received_quantity
            ]);

            await conn.promise().query(
                `INSERT INTO requisition_items 
         (requisition_id, product_id, product_name, variant_id, variant_name, 
          requested_quantity, factory_send_quantity, pos_received_quantity)
         VALUES ?`,
                [itemsData]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'create',
                null,
                RequisitionStatuses.CALL_CENTER.PENDING,
                'Requisition initiated by POS staff'
            );

            await conn.promise().query('COMMIT');

            return res.status(201).json({
                success: true,
                message: '✅ Requisition created successfully',
                data: {
                    requisition_id,
                    requisition_no,
                    total_quantity,
                    status: {
                        call_center_manager_status: RequisitionStatuses.CALL_CENTER.PENDING,
                        factory_incharge_status: RequisitionStatuses.FACTORY_INCHARGE.PENDING,
                        factory_team_assign_status: RequisitionStatuses.FACTORY_TEAM.PENDING,
                        pos_received_status: RequisitionStatuses.POS_RECEIVED.PENDING
                    }
                }
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error creating requisition:', error);
            return res.status(500).json({
                success: false,
                message: 'Error creating requisition',
                error: error.message
            });
        }
    })
);

/**
 * GET: Fetch single requisition with all details
 * GET /api/requisitions/:requisition_id
 * Access: Private
 */
Router.get(
    '/:requisition_id',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('🔍 Fetching requisition details');
        const { requisition_id } = req.params;
        const conn = connection;

        try {
            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Fetch logs
            const [logs] = await conn.promise().query(
                `SELECT * FROM requisition_logs WHERE requisition_id = ? ORDER BY created_at DESC`,
                [requisition_id]
            );

            requisition.logs = logs;

            return res.status(200).json({
                success: true,
                data: requisition
            });
        } catch (error) {
            console.error('❌ Error fetching requisition:', error);
            return res.status(500).json({
                success: false,
                message: 'Error fetching requisition',
                error: error.message
            });
        }
    })
);

/**
 * GET: List all requisitions with pagination
 * GET /api/requisitions?page=1&limit=10&status=pending
 * Access: Private
 */
Router.get(
    '/',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('📋 Fetching requisitions list');
        const { page, limit, pos_id, call_center_manager_status } = req.query;
        const { pageNo, offset, pageSize } = getPagination(page, limit);
        const conn = connection;

        try {
            let whereConditions = [];
            let params = [];

            if (pos_id) {
                whereConditions.push('pos_id = ?');
                params.push(pos_id);
            }

            if (call_center_manager_status) {
                whereConditions.push('call_center_manager_status = ?');
                params.push(call_center_manager_status);
            }

            const whereClause = whereConditions.length ? 'WHERE ' + whereConditions.join(' AND ') : '';

            const [total] = await conn.promise().query(
                `SELECT COUNT(*) as count FROM requisitions ${whereClause}`,
                params
            );

            const [requisitions] = await conn.promise().query(
                `SELECT * FROM requisitions ${whereClause} 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
                [...params, pageSize, offset]
            );

            return res.status(200).json({
                success: true,
                data: requisitions,
                pagination: {
                    pageNo,
                    pageSize,
                    totalRecords: total[0].count
                }
            });
        } catch (error) {
            console.error('❌ Error fetching requisitions:', error);
            return res.status(500).json({
                success: false,
                message: 'Error fetching requisitions',
                error: error.message
            });
        }
    })
);

/**
 * UPDATE: Edit requisition (Smart Edit Logic)
 * PUT /api/requisitions/:requisition_id
 * 
 * Rule: 
 * - If factory_team_assign_status is NOT 'delivered': Update existing record
 * - If factory_team_assign_status IS 'delivered': Generate NEW requisition ID
 */
Router.put(
    '/:requisition_id',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('✏️ Updating requisition');
        const error = validateUpdateRequisition(req, res);
        if (error) return;

        const { requisition_id } = req.params;
        const { pos_remark, items, factory_remark } = req.body;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            // Fetch current requisition
            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Check if editing is allowed (Smart Edit Rule)
            if (!canEditRequisition(requisition)) {
                // CONDITION B: factory_team_assign_status IS 'delivered'
                // Create a NEW requisition instead
                console.log('📋 Creating new requisition due to delivered status');

                const new_requisition_no = await generateRequisitionNo();
                const total_quantity = items.reduce((sum, item) => sum + item.requested_quantity, 0);

                // Insert new requisition
                const [result] = await conn.promise().query(
                    `INSERT INTO requisitions 
           (requisition_no, pos_id, total_quantity, pos_remark, requisition_sender_id,
            call_center_manager_status, factory_incharge_status, factory_team_assign_status, pos_received_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        new_requisition_no,
                        requisition.pos_id,
                        total_quantity,
                        pos_remark || null,
                        userId,
                        RequisitionStatuses.CALL_CENTER.PENDING,
                        RequisitionStatuses.FACTORY_INCHARGE.PENDING,
                        RequisitionStatuses.FACTORY_TEAM.PENDING,
                        RequisitionStatuses.POS_RECEIVED.PENDING
                    ]
                );

                const new_requisition_id = result.insertId;

                // Insert new items
                const newItemsData = items.map((item) => [
                    new_requisition_id,
                    item.product_id,
                    item.product_name,
                    item.variant_id,
                    item.variant_name,
                    item.requested_quantity,
                    0,
                    0
                ]);

                await conn.promise().query(
                    `INSERT INTO requisition_items 
           (requisition_id, product_id, product_name, variant_id, variant_name, 
            requested_quantity, factory_send_quantity, pos_received_quantity)
           VALUES ?`,
                    [newItemsData]
                );

                // Create audit log
                await createAuditLog(
                    conn,
                    new_requisition_id,
                    userId,
                    'edit_by_regeneration',
                    null,
                    RequisitionStatuses.CALL_CENTER.PENDING,
                    `New requisition generated from completed requisition #${requisition.requisition_no}`
                );

                await conn.promise().query('COMMIT');

                return res.status(201).json({
                    success: true,
                    message: '✅ New requisition created (previous one already delivered)',
                    data: {
                        requisition_id: new_requisition_id,
                        requisition_no: new_requisition_no,
                        original_requisition_id: requisition_id
                    }
                });
            }

            // CONDITION A: factory_team_assign_status is NOT 'delivered'
            // Update existing record and reset to Call Center approval
            console.log('📝 Updating existing requisition');

            const total_quantity = items.reduce((sum, item) => sum + item.requested_quantity, 0);

            // Update master record
            await conn.promise().query(
                `UPDATE requisitions 
         SET pos_remark = ?, factory_remark = ?, 
             total_quantity = ?,
             call_center_manager_status = ?,
             factory_incharge_status = ?,
             factory_team_assign_status = ?,
             updated_at = NOW()
         WHERE requisition_id = ?`,
                [
                    pos_remark || null,
                    factory_remark || null,
                    total_quantity,
                    RequisitionStatuses.CALL_CENTER.PENDING,
                    RequisitionStatuses.FACTORY_INCHARGE.PENDING,
                    RequisitionStatuses.FACTORY_TEAM.PENDING,
                    requisition_id
                ]
            );

            // Delete old items
            await conn.promise().query(
                `DELETE FROM requisition_items WHERE requisition_id = ?`,
                [requisition_id]
            );

            // Insert new items
            const itemsData = items.map((item) => [
                requisition_id,
                item.product_id,
                item.product_name,
                item.variant_id,
                item.variant_name,
                item.requested_quantity,
                0,
                0
            ]);

            await conn.promise().query(
                `INSERT INTO requisition_items 
         (requisition_id, product_id, product_name, variant_id, variant_name, 
          requested_quantity, factory_send_quantity, pos_received_quantity)
         VALUES ?`,
                [itemsData]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'edit',
                null,
                RequisitionStatuses.CALL_CENTER.PENDING,
                'Requisition edited - sent back to Call Center Manager for approval'
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: '✅ Requisition updated and sent for approval'
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error updating requisition:', error);
            return res.status(500).json({
                success: false,
                message: 'Error updating requisition',
                error: error.message
            });
        }
    })
);

/**
 * STEP 1: Call Center Manager Approval
 * POST /api/requisitions/:requisition_id/call-center-approval
 * Sets factory_incharge_status to 'pending' if approved
 */
Router.post(
    '/:requisition_id/call-center-approval',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('✅ Call Center Manager Approval');
        const error = validateCallCenterApproval(req, res);
        if (error) return;

        const { requisition_id } = req.params;
        const { call_center_manager_status, factory_remark } = req.body;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            const oldStatus = requisition.call_center_manager_status;
            let newFactoryInchargeStatus = RequisitionStatuses.FACTORY_INCHARGE.PENDING;

            // If rejected, keep factory status as pending
            if (call_center_manager_status === 'rejected') {
                newFactoryInchargeStatus = RequisitionStatuses.FACTORY_INCHARGE.PENDING;
            }

            // Update requisition
            await conn.promise().query(
                `UPDATE requisitions 
         SET call_center_manager_status = ?,
             factory_incharge_status = ?,
             factory_remark = COALESCE(?, factory_remark),
             updated_at = NOW()
         WHERE requisition_id = ?`,
                [call_center_manager_status, newFactoryInchargeStatus, factory_remark, requisition_id]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'status_change',
                oldStatus,
                call_center_manager_status,
                `Call Center Manager: ${call_center_manager_status.toUpperCase()}${factory_remark ? ' - ' + factory_remark : ''}`
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: `✅ Requisition ${call_center_manager_status === 'approved' ? 'approved' : call_center_manager_status} by Call Center Manager`,
                data: {
                    requisition_id,
                    call_center_manager_status,
                    factory_incharge_status: newFactoryInchargeStatus
                }
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error in call center approval:', error);
            return res.status(500).json({
                success: false,
                message: 'Error processing approval',
                error: error.message
            });
        }
    })
);

/**
 * STEP 2: Factory Incharge Approval
 * POST /api/requisitions/:requisition_id/factory-incharge-approval
 * Sets factory_team_assign_status to 'pending' if approved
 */
Router.post(
    '/:requisition_id/factory-incharge-approval',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('✅ Factory Incharge Approval');
        const error = validateFactoryInchargeApproval(req, res);
        if (error) return;

        const { requisition_id } = req.params;
        const { factory_incharge_status, factory_remark } = req.body;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Check Call Center approval first
            if (requisition.call_center_manager_status !== 'approved') {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Call Center Manager must approve first'
                });
            }

            const oldStatus = requisition.factory_incharge_status;
            let newFactoryTeamStatus = RequisitionStatuses.FACTORY_TEAM.PENDING;

            // Update requisition
            await conn.promise().query(
                `UPDATE requisitions 
         SET factory_incharge_status = ?,
             factory_team_assign_status = ?,
             factory_remark = COALESCE(?, factory_remark),
             updated_at = NOW()
         WHERE requisition_id = ?`,
                [factory_incharge_status, newFactoryTeamStatus, factory_remark, requisition_id]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'status_change',
                oldStatus,
                factory_incharge_status,
                `Factory Incharge: ${factory_incharge_status.toUpperCase()}${factory_remark ? ' - ' + factory_remark : ''}`
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: `✅ Requisition ${factory_incharge_status === 'approved' ? 'approved' : factory_incharge_status} by Factory Incharge`,
                data: {
                    requisition_id,
                    factory_incharge_status,
                    factory_team_assign_status: newFactoryTeamStatus
                }
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error in factory incharge approval:', error);
            return res.status(500).json({
                success: false,
                message: 'Error processing approval',
                error: error.message
            });
        }
    })
);

/**
 * STEP 3: Factory Team Assignment & Dispatch
 * POST /api/requisitions/:requisition_id/factory-team-assign
 * Factory team confirms quantities and marks as delivered
 * Sets pos_received_status to 'ongoing'
 */
Router.post(
    '/:requisition_id/factory-team-assign',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('📦 Factory Team Assignment');
        const error = validateFactoryTeamAssignment(req, res);
        if (error) return;

        const { requisition_id } = req.params;
        const { factory_team_assign_status, items, factory_remark } = req.body;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Check previous approvals
            if (requisition.factory_incharge_status !== 'approved') {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Factory Incharge must approve first'
                });
            }

            // Validate quantities
            const quantityErrors = validateQuantities(items, requisition.items);
            if (quantityErrors.length > 0) {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Quantity validation failed',
                    errors: quantityErrors
                });
            }

            // Update item quantities
            for (const item of items) {
                await conn.promise().query(
                    `UPDATE requisition_items 
           SET factory_send_quantity = ? 
           WHERE requisition_item_id = ?`,
                    [item.factory_send_quantity, item.requisition_item_id]
                );
            }

            const newPosReceivedStatus = factory_team_assign_status === 'delivered'
                ? RequisitionStatuses.POS_RECEIVED.ONGOING
                : RequisitionStatuses.POS_RECEIVED.PENDING;

            // Update requisition
            await conn.promise().query(
                `UPDATE requisitions 
         SET factory_team_assign_status = ?,
             pos_received_status = ?,
             factory_remark = COALESCE(?, factory_remark),
             updated_at = NOW()
         WHERE requisition_id = ?`,
                [factory_team_assign_status, newPosReceivedStatus, factory_remark, requisition_id]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'status_change',
                'pending',
                factory_team_assign_status,
                `Factory Team: ${factory_team_assign_status.toUpperCase()} - Items ready for delivery`
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: '✅ Factory team assignment completed',
                data: {
                    requisition_id,
                    factory_team_assign_status,
                    pos_received_status: newPosReceivedStatus
                }
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error in factory team assignment:', error);
            return res.status(500).json({
                success: false,
                message: 'Error processing assignment',
                error: error.message
            });
        }
    })
);

/**
 * STEP 4: POS Receipt & Inventory Sync
 * POST /api/requisitions/:requisition_id/pos-receipt
 * 
 * When pos_received_status changes to 'delivered':
 * - Automatically update pos_quantity in product_variant_option_combinations
 * - TRANSACTION: If inventory update fails, rollback requisition status
 */
Router.post(
    '/:requisition_id/pos-receipt',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('🎁 POS Receipt & Inventory Sync');
        const error = validatePosReceipt(req, res);
        if (error) return;

        const { requisition_id } = req.params;
        const { pos_received_status, items, pos_remark } = req.body;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Check factory team status
            if (requisition.factory_team_assign_status !== 'delivered') {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Factory team must deliver first'
                });
            }

            // Validate quantities
            const quantityErrors = validateQuantities(items, requisition.items);
            if (quantityErrors.length > 0) {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Quantity validation failed',
                    errors: quantityErrors
                });
            }

            // Update item quantities
            for (const item of items) {
                await conn.promise().query(
                    `UPDATE requisition_items 
           SET pos_received_quantity = ? 
           WHERE requisition_item_id = ?`,
                    [item.pos_received_quantity, item.requisition_item_id]
                );
            }

            // CRITICAL: If marking as delivered, update inventory
            if (pos_received_status === 'delivered') {
                try {
                    await updateInventoryOnDelivery(conn, items, requisition_id);
                    console.log('✅ Inventory updated successfully');
                } catch (inventoryError) {
                    // Rollback on inventory failure
                    await conn.promise().query('ROLLBACK');
                    console.error('❌ Inventory update failed - Transaction rolled back:', inventoryError);
                    return res.status(500).json({
                        success: false,
                        message: 'Inventory update failed - receipt cancelled to prevent ghost inventory',
                        error: inventoryError.message
                    });
                }
            }

            // Update requisition
            await conn.promise().query(
                `UPDATE requisitions 
         SET pos_received_status = ?,
             pos_remark = COALESCE(?, pos_remark),
             updated_at = NOW()
         WHERE requisition_id = ?`,
                [pos_received_status, pos_remark, requisition_id]
            );

            // Create audit log
            await createAuditLog(
                conn,
                requisition_id,
                userId,
                'pos_receipt',
                RequisitionStatuses.POS_RECEIVED.ONGOING,
                pos_received_status,
                `POS: ${pos_received_status.toUpperCase()}${pos_remark ? ' - ' + pos_remark : ''}`
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: `✅ POS receipt completed and inventory synchronized${pos_received_status === 'delivered' ? ' ✨' : ''}`,
                data: {
                    requisition_id,
                    pos_received_status,
                    inventory_synced: pos_received_status === 'delivered'
                }
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error in POS receipt:', error);
            return res.status(500).json({
                success: false,
                message: 'Error processing receipt',
                error: error.message
            });
        }
    })
);

/**
 * GET: Fetch requisition logs
 * GET /api/requisitions/:requisition_id/logs
 */
Router.get(
    '/:requisition_id/logs',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('📜 Fetching requisition logs');
        const { requisition_id } = req.params;
        const conn = connection;

        try {
            const [logs] = await conn.promise().query(
                `SELECT rl.*, sa.name as user_name, sa.email 
         FROM requisition_logs rl
         LEFT JOIN store_admins sa ON rl.user_id = sa.user_id
         WHERE rl.requisition_id = ? 
         ORDER BY rl.created_at DESC`,
                [requisition_id]
            );

            return res.status(200).json({
                success: true,
                data: logs
            });
        } catch (error) {
            console.error('❌ Error fetching logs:', error);
            return res.status(500).json({
                success: false,
                message: 'Error fetching logs',
                error: error.message
            });
        }
    })
);

/**
 * DELETE: Soft delete requisition (only if not started approval)
 * DELETE /api/requisitions/:requisition_id
 */
Router.delete(
    '/:requisition_id',
    [auth, authorize],
    asyncMiddleware(async (req, res) => {
        console.log('🗑️ Deleting requisition');
        const { requisition_id } = req.params;
        const userId = req.user.user_id;
        const conn = connection;

        try {
            await conn.promise().query('START TRANSACTION');

            const requisition = await getRequisitionWithDetails(conn, requisition_id);

            if (!requisition) {
                await conn.promise().query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Requisition not found'
                });
            }

            // Only allow deletion if in pending status
            if (requisition.call_center_manager_status !== 'pending') {
                await conn.promise().query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Cannot delete requisition after approval has started'
                });
            }

            // Delete items first
            await conn.promise().query(
                `DELETE FROM requisition_items WHERE requisition_id = ?`,
                [requisition_id]
            );

            // Delete requisition
            await conn.promise().query(
                `DELETE FROM requisitions WHERE requisition_id = ?`,
                [requisition_id]
            );

            // Note: Delete logs as well (optional - can also keep for audit trail)
            await conn.promise().query(
                `DELETE FROM requisition_logs WHERE requisition_id = ?`,
                [requisition_id]
            );

            await conn.promise().query('COMMIT');

            return res.status(200).json({
                success: true,
                message: '✅ Requisition deleted successfully'
            });
        } catch (error) {
            await conn.promise().query('ROLLBACK');
            console.error('❌ Error deleting requisition:', error);
            return res.status(500).json({
                success: false,
                message: 'Error deleting requisition',
                error: error.message
            });
        }
    })
);

module.exports = Router;
