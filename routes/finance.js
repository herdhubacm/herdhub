const express = require('express');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

function san(s, max) { return s ? String(s).trim().slice(0, max) : null; }
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function intN(v) { const n = parseInt(v); return isNaN(n) ? null : n; }

// ── GET /api/finance/transactions ─────────────────────
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const { year, type, category, from, to, q } = req.query;
    const conds = ['user_id=$1'];
    const params = [req.user.id];
    let p = 2;
    if (year) { conds.push('tax_year=$' + p); params.push(parseInt(year)); p++; }
    if (type) { conds.push('type=$' + p); params.push(type); p++; }
    if (category) { conds.push('category=$' + p); params.push(category); p++; }
    if (from) { conds.push('transaction_date>=$' + p); params.push(from); p++; }
    if (to) { conds.push('transaction_date<=$' + p); params.push(to); p++; }
    if (q) { conds.push('description ILIKE $' + p); params.push('%' + q + '%'); p++; }

    const { rows } = await query(
      `SELECT * FROM finance_transactions WHERE ${conds.join(' AND ')} ORDER BY transaction_date DESC, created_at DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET transactions error:', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── POST /api/finance/transactions ────────────────────
router.post('/transactions', authenticateToken, async (req, res) => {
  try {
    const b = req.body;
    const txDate = b.transaction_date || new Date().toISOString().slice(0, 10);
    const taxYear = intN(b.tax_year) || new Date(txDate).getFullYear();
    const { rows } = await query(
      `INSERT INTO finance_transactions (user_id, transaction_date, category, type, description,
        amount, head_count, price_per_head, weight_lbs, price_per_cwt, animal_id, tax_year, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user.id, txDate, san(b.category, 50), san(b.type, 10),
       san(b.description, 200), num(b.amount), intN(b.head_count),
       num(b.price_per_head), num(b.weight_lbs), num(b.price_per_cwt),
       intN(b.animal_id), taxYear, san(b.notes, 1000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST transaction error:', err.message);
    res.status(500).json({ error: 'Failed to save transaction' });
  }
});

// ── PUT /api/finance/transactions/:id ─────────────────
router.put('/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body;
    const txDate = b.transaction_date || new Date().toISOString().slice(0, 10);
    const taxYear = intN(b.tax_year) || new Date(txDate).getFullYear();
    const { rows, rowCount } = await query(
      `UPDATE finance_transactions SET transaction_date=$2, category=$3, type=$4, description=$5,
        amount=$6, head_count=$7, price_per_head=$8, weight_lbs=$9, price_per_cwt=$10,
        animal_id=$11, tax_year=$12, notes=$13
       WHERE id=$1 AND user_id=$14 RETURNING *`,
      [id, txDate, san(b.category, 50), san(b.type, 10), san(b.description, 200),
       num(b.amount), intN(b.head_count), num(b.price_per_head), num(b.weight_lbs),
       num(b.price_per_cwt), intN(b.animal_id), taxYear, san(b.notes, 1000), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT transaction error:', err.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ── DELETE /api/finance/transactions/:id ──────────────
router.delete('/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM finance_transactions WHERE id=$1 AND user_id=$2',
      [parseInt(req.params.id), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ── GET /api/finance/summary ──────────────────────────
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const totals = await query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type='income'), 0) AS total_income,
        COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0) AS total_expenses
      FROM finance_transactions WHERE user_id=$1 AND tax_year=$2`, [req.user.id, year]);

    const byCategory = await query(`
      SELECT category, type, SUM(amount) AS total
      FROM finance_transactions WHERE user_id=$1 AND tax_year=$2
      GROUP BY category, type ORDER BY total DESC`, [req.user.id, year]);

    const byMonth = await query(`
      SELECT EXTRACT(MONTH FROM transaction_date)::integer AS month, type,
        SUM(amount) AS total
      FROM finance_transactions WHERE user_id=$1 AND tax_year=$2
      GROUP BY month, type ORDER BY month`, [req.user.id, year]);

    const t = totals.rows[0];
    const income = parseFloat(t.total_income);
    const expenses = parseFloat(t.total_expenses);
    const net = income - expenses;
    const margin = income > 0 ? (net / income * 100) : 0;

    res.json({
      year, total_income: income, total_expenses: expenses,
      net_profit: net, profit_margin: Math.round(margin * 10) / 10,
      by_category: byCategory.rows,
      by_month: byMonth.rows
    });
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── GET /api/finance/budgets ──────────────────────────
router.get('/budgets', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const { rows } = await query(
      'SELECT * FROM finance_budgets WHERE user_id=$1 AND tax_year=$2 ORDER BY category', [req.user.id, year]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load budgets' });
  }
});

// ── POST /api/finance/budgets ─────────────────────────
router.post('/budgets', authenticateToken, async (req, res) => {
  try {
    const { category, budgeted_amount, tax_year } = req.body;
    const year = parseInt(tax_year) || new Date().getFullYear();
    const { rows } = await query(
      `INSERT INTO finance_budgets (user_id, category, budgeted_amount, tax_year)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT ON CONSTRAINT finance_budgets_user_cat_year
       DO UPDATE SET budgeted_amount=$3 RETURNING *`,
      [req.user.id, san(category, 50), num(budgeted_amount), year]);
    res.json(rows[0]);
  } catch (err) {
    // If constraint doesn't exist, try upsert manually
    try {
      const year = parseInt(req.body.tax_year) || new Date().getFullYear();
      await query('DELETE FROM finance_budgets WHERE user_id=$1 AND category=$2 AND tax_year=$3',
        [req.user.id, san(req.body.category, 50), year]);
      const { rows } = await query(
        `INSERT INTO finance_budgets (user_id, category, budgeted_amount, tax_year)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.user.id, san(req.body.category, 50), num(req.body.budgeted_amount), year]);
      res.json(rows[0]);
    } catch (err2) {
      console.error('POST budget error:', err2.message);
      res.status(500).json({ error: 'Failed to save budget' });
    }
  }
});

// ── GET /api/finance/export ───────────────────────────
router.get('/export', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT transaction_date, type, category, description, amount,
        head_count, price_per_head, weight_lbs, price_per_cwt, notes
       FROM finance_transactions WHERE user_id=$1 AND tax_year=$2
       ORDER BY transaction_date ASC`, [req.user.id, year]);

    let csv = 'Date,Type,Category,Description,Amount,Head Count,Price/Head,Weight(lbs),Price/CWT,Notes\n';
    rows.forEach(r => {
      csv += [
        r.transaction_date ? r.transaction_date.toISOString().slice(0,10) : '',
        r.type, r.category, '"' + (r.description||'').replace(/"/g,'""') + '"',
        r.amount, r.head_count||'', r.price_per_head||'', r.weight_lbs||'',
        r.price_per_cwt||'', '"' + (r.notes||'').replace(/"/g,'""') + '"'
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="herdhub-finance-${year}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export' });
  }
});

module.exports = router;
