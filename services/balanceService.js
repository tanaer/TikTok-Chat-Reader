const db = require('../db');

/**
 * Generate a unique order number
 */
function generateOrderNo(prefix = 'ORD') {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-T:\.Z]/g, '').substring(0, 14);
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${prefix}${dateStr}${rand}`;
}

/**
 * Adjust user balance within a transaction
 * Returns { success, balanceBefore, balanceAfter, error }
 */
async function adjustBalance(userId, amount, type, remark, refOrderNo = null, operatorId = null) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Lock user row for update
        const userResult = await client.query(
            `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
            [userId]
        );
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: '用户不存在' };
        }

        const balanceBefore = Number(userResult.rows[0].balance);
        const balanceAfter = balanceBefore + Math.round(amount);

        if (balanceAfter < 0) {
            await client.query('ROLLBACK');
            return { success: false, error: '余额不足' };
        }

        // Update balance
        await client.query(
            `UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2`,
            [balanceAfter, userId]
        );

        // Record balance log
        await client.query(
            `INSERT INTO balance_log (user_id, type, amount, balance_before, balance_after, ref_order_no, description, operator_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userId, type, Math.round(amount), balanceBefore, balanceAfter, refOrderNo, remark, operatorId]
        );

        await client.query('COMMIT');
        return { success: true, balanceBefore, balanceAfter };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Balance] Transaction error:', err.message);
        return { success: false, error: '余额操作失败' };
    } finally {
        client.release();
    }
}

/**
 * Purchase with balance - creates order and adjusts balance atomically
 * Returns { success, order, error }
 */
async function purchaseWithBalance(userId, amount, orderType, itemName, remark) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Lock user row
        const userResult = await client.query(
            `SELECT id, balance FROM users WHERE id = $1 FOR UPDATE`,
            [userId]
        );
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: '用户不存在' };
        }

        const balanceBefore = Number(userResult.rows[0].balance);
        const amountInt = Math.round(amount);
        if (balanceBefore < amountInt) {
            await client.query('ROLLBACK');
            return { success: false, error: '余额不足', balanceNeeded: amountInt, balanceCurrent: balanceBefore };
        }

        const balanceAfter = balanceBefore - amountInt;
        const orderNo = generateOrderNo();

        // Create payment record
        const orderResult = await client.query(
            `INSERT INTO payment_records (order_no, user_id, type, item_name, amount, status, payment_method, remark)
             VALUES ($1, $2, $3, $4, $5, 'paid', 'balance', $6) RETURNING id`,
            [orderNo, userId, orderType, itemName, amountInt, remark]
        );
        const orderId = orderResult.rows[0].id;

        // Update balance
        await client.query(
            `UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2`,
            [balanceAfter, userId]
        );

        // Record balance log (ref_order_no is VARCHAR, description is TEXT)
        await client.query(
            `INSERT INTO balance_log (user_id, type, amount, balance_before, balance_after, ref_order_no, description)
             VALUES ($1, 'purchase', $2, $3, $4, $5, $6)`,
            [userId, -amountInt, balanceBefore, balanceAfter, orderNo, itemName]
        );

        await client.query('COMMIT');
        return { success: true, order: { id: orderId, orderNo, amount: amountInt, balanceAfter } };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Balance] Purchase error:', err.message);
        return { success: false, error: '购买操作失败' };
    } finally {
        client.release();
    }
}

module.exports = {
    generateOrderNo,
    adjustBalance,
    purchaseWithBalance
};
