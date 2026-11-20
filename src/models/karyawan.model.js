/**
 * src/models/karyawan.model.js
 * =============================================================================
 * Akses tabel `karyawan` (data staff: owner/manager/kasir/operator/kurir).
 * Tabel: id, cabang_id, role_id, nama, username, password_hash, status, created_at, updated_at.
 *
 * Dipakai oleh auth.service (login) & master.service (kelola staff).
 * Catatan keamanan: password_hash HANYA diambil di findForAuth (untuk verifikasi bcrypt);
 * fungsi lain mengembalikan data tanpa hash.
 * =============================================================================
 */

const db = require('../config/database');

// Kolom aman untuk dikembalikan ke client (tanpa password_hash)
const SAFE_FIELDS = `
  k.id, k.cabang_id, k.role_id, k.nama, k.telepon, k.jatah_cuci_mingguan, k.username, k.status,
  k.created_at, k.updated_at,
  r.nama_role AS role,
  c.kode AS cabang_kode, c.nama AS cabang_nama, c.nilai_per_poin
`;

const JOINS = `
  FROM karyawan k
  JOIN role r   ON r.id = k.role_id
  JOIN cabang c ON c.id = k.cabang_id
`;

/**
 * Ambil 1 karyawan by username UNTUK AUTENTIKASI.
 * Termasuk password_hash + role + cabang. Return null kalau tidak ada.
 */
async function findForAuth(username) {
  const sql = `
    SELECT
      k.id, k.cabang_id, k.role_id, k.nama, k.username, k.password_hash, k.status,
      r.nama_role AS role,
      c.kode AS cabang_kode, c.nama AS cabang_nama, c.nilai_per_poin
    ${JOINS}
    WHERE k.username = ?
    LIMIT 1
  `;
  return db.queryOne(sql, [username]);
}

/**
 * Ambil 1 karyawan by id (tanpa password_hash) — dipakai GET /auth/me, dll.
 */
async function findById(id) {
  const sql = `SELECT ${SAFE_FIELDS} ${JOINS} WHERE k.id = ? LIMIT 1`;
  return db.queryOne(sql, [id]);
}

/**
 * Daftar karyawan (opsional filter cabang) — tanpa password_hash.
 */
async function findAll({ cabangId = null } = {}) {
  let sql = `SELECT ${SAFE_FIELDS} ${JOINS}`;
  const params = [];
  if (cabangId !== null) { sql += ` WHERE k.cabang_id = ?`; params.push(cabangId); }
  sql += ` ORDER BY k.nama ASC`;
  return db.query(sql, params);
}

/** Daftar karyawan per cabang, opsional filter role (exclude owner/manager untuk view manager). */
async function findByCabangRole(cabangId, { excludeRoles = [] } = {}) {
  let sql = `SELECT ${SAFE_FIELDS} ${JOINS} WHERE k.cabang_id = ?`;
  const params = [cabangId];
  if (excludeRoles.length) {
    sql += ` AND r.nama_role NOT IN (${excludeRoles.map(() => '?').join(',')})`;
    params.push(...excludeRoles);
  }
  sql += ` ORDER BY k.status ASC, k.nama ASC`;
  return db.query(sql, params);
}

/** Cari role id by nama_role. */
async function roleIdByNama(namaRole) {
  const row = await db.queryOne(`SELECT id FROM role WHERE nama_role = ? LIMIT 1`, [namaRole]);
  return row ? row.id : null;
}

/** Cek username sudah dipakai (opsional exclude id tertentu untuk edit). */
async function usernameDipakai(username, exceptId = null) {
  let sql = `SELECT id FROM karyawan WHERE username = ?`;
  const params = [username];
  if (exceptId) { sql += ` AND id <> ?`; params.push(exceptId); }
  const row = await db.queryOne(sql + ' LIMIT 1', params);
  return !!row;
}

/** Buat karyawan baru. @returns insertId */
async function create(data) {
  const [r] = await db.pool.execute(
    `INSERT INTO karyawan (cabang_id, role_id, nama, username, password_hash, status)
     VALUES (?,?,?,?,?,?)`,
    [data.cabang_id, data.role_id, data.nama, data.username, data.password_hash, data.status || 'aktif']
  );
  return r.insertId;
}

/** Update data dasar (nama, role). */
async function updateData(id, { nama, role_id, telepon, jatah_cuci_mingguan }) {
  await db.pool.execute(`UPDATE karyawan SET nama = ?, role_id = ? WHERE id = ?`, [nama, role_id, id]);
  // Perubahan #39: HP + jatah cuci (hanya kalau dikirim)
  if (telepon !== undefined) await db.pool.execute(`UPDATE karyawan SET telepon = ? WHERE id = ?`, [telepon, id]);
  if (jatah_cuci_mingguan !== undefined) await db.pool.execute(`UPDATE karyawan SET jatah_cuci_mingguan = ? WHERE id = ?`, [jatah_cuci_mingguan, id]);
}

/** Set status aktif/nonaktif. */
async function setStatus(id, status) {
  await db.pool.execute(`UPDATE karyawan SET status = ? WHERE id = ?`, [status, id]);
}

/** Reset password (hash sudah dibuat di service). */
async function setPassword(id, passwordHash) {
  await db.pool.execute(`UPDATE karyawan SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
  await tandaiPasswordDiubah(id);
}

/**
 * Perubahan #82: catat waktu password diganti/direset -> token lama (dibuat
 * sebelum waktu ini) ditolak middleware auth. Diam kalau kolom belum ada
 * (SQL 2026-11-17_ganti_password belum dijalankan).
 */
async function tandaiPasswordDiubah(id) {
  try {
    // jam dari server Node (sama dengan jam iat token), bukan NOW() MariaDB
    await db.pool.execute(`UPDATE karyawan SET password_diubah_at = FROM_UNIXTIME(?) WHERE id = ?`, [(Date.now() / 1000).toFixed(3), id]);
  } catch (e) {
    if (e && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  try { require('../middleware/auth').lupakanCache(id); } catch (e) { /* abaikan */ }
}

/** Hash password by id (untuk cek password lama). */
async function passwordHashById(id) {
  const [rows] = await db.pool.execute(`SELECT password_hash FROM karyawan WHERE id = ?`, [id]);
  return rows[0] ? rows[0].password_hash : null;
}

/** Milidetik UNIX password terakhir diganti (null = belum / kolom belum ada). */
async function passwordDiubahTs(id) {
  try {
    const [rows] = await db.pool.execute(`SELECT UNIX_TIMESTAMP(password_diubah_at) AS ts FROM karyawan WHERE id = ?`, [id]);
    return rows[0] && rows[0].ts != null ? Math.round(Number(rows[0].ts) * 1000) : null;
  } catch (e) {
    if (e && e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

module.exports = {
  tandaiPasswordDiubah, passwordHashById, passwordDiubahTs,
  findForAuth, findById, findAll, findByCabangRole, roleIdByNama,
  usernameDipakai, create, updateData, setStatus, setPassword,
};
