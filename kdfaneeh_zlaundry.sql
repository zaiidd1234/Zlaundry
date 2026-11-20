CREATE DATABASE IF NOT EXISTS `kdfaneeh_zlaundry` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `kdfaneeh_zlaundry`;

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `kdfaneeh_zlaundry`
--

-- --------------------------------------------------------

--
-- Table structure for table `absensi`
--

CREATE TABLE `absensi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `tanggal` date NOT NULL COMMENT 'Tanggal absen masuk',
  `jam_masuk` datetime NOT NULL,
  `lat_masuk` decimal(10,7) DEFAULT NULL,
  `lng_masuk` decimal(10,7) DEFAULT NULL,
  `jarak_masuk_m` int(11) DEFAULT NULL,
  `lembur_ganti_shift` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = lembur menggantikan shift orang',
  `jam_pulang` datetime DEFAULT NULL,
  `lat_pulang` decimal(10,7) DEFAULT NULL,
  `lng_pulang` decimal(10,7) DEFAULT NULL,
  `jarak_pulang_m` int(11) DEFAULT NULL,
  `pulang_lembur` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = pulang terlambat karena lembur',
  `pulang_dikoreksi` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = jam pulang dari koreksi yang disetujui',
  `terakhir_di_outlet_at` datetime DEFAULT NULL COMMENT 'Terakhir terdeteksi di dalam radius',
  `luar_radius_sejak` datetime DEFAULT NULL COMMENT 'Pertama terdeteksi di luar radius (reset saat kembali)',
  `lokasi_terakhir_at` datetime DEFAULT NULL,
  `jarak_terakhir_m` int(11) DEFAULT NULL,
  `pulang_otomatis` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = ditutup sistem (lupa absen pulang)',
  `perangkat` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `absensi_koreksi`
--

CREATE TABLE `absensi_koreksi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `absensi_id` bigint(20) UNSIGNED NOT NULL,
  `jam_pulang_usulan` datetime NOT NULL,
  `pulang_lembur` tinyint(1) NOT NULL DEFAULT 0,
  `alasan` varchar(255) NOT NULL,
  `status` enum('menunggu','disetujui','ditolak') NOT NULL DEFAULT 'menunggu',
  `diajukan_oleh` bigint(20) UNSIGNED NOT NULL,
  `diputuskan_oleh` bigint(20) UNSIGNED DEFAULT NULL,
  `diputuskan_at` datetime DEFAULT NULL,
  `catatan_keputusan` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `barang`
--

CREATE TABLE `barang` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `coa_id` bigint(20) UNSIGNED NOT NULL,
  `nama` varchar(100) NOT NULL,
  `kategori` enum('laundry','cafe') NOT NULL DEFAULT 'laundry',
  `urutan` int(11) NOT NULL DEFAULT 100,
  `satuan` varchar(20) NOT NULL,
  `harga_beli` decimal(12,2) NOT NULL,
  `harga_jual` decimal(12,2) NOT NULL,
  `stok_terkini` int(11) NOT NULL DEFAULT 0,
  `stok_minimum` int(11) NOT NULL DEFAULT 0,
  `status` enum('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `barang_foto`
--

CREATE TABLE `barang_foto` (
  `barang_id` bigint(20) UNSIGNED NOT NULL,
  `mime` varchar(30) NOT NULL,
  `data` mediumblob NOT NULL,
  `ukuran` int(11) NOT NULL DEFAULT 0,
  `diubah_oleh` bigint(20) UNSIGNED DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cabang`
--

CREATE TABLE `cabang` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `kode` varchar(10) NOT NULL,
  `nama` varchar(100) NOT NULL,
  `alamat` varchar(255) DEFAULT NULL,
  `kota` varchar(50) DEFAULT NULL,
  `provinsi` varchar(50) DEFAULT NULL,
  `no_hp` varchar(20) DEFAULT NULL,
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `radius_absen_m` int(11) NOT NULL DEFAULT 50 COMMENT 'Jarak maksimal absen kasir dari titik outlet (meter)',
  `absensi_aktif` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = kasir wajib absen (gerbang lokasi), 0 = absensi nonaktif',
  `link_wa` varchar(255) DEFAULT NULL,
  `link_gmap_review` varchar(255) DEFAULT NULL,
  `link_ig` varchar(255) DEFAULT NULL,
  `link_fb` varchar(255) DEFAULT NULL,
  `link_tiktok` varchar(255) DEFAULT NULL,
  `link_logo` varchar(255) DEFAULT NULL,
  `target_omzet_bulanan` decimal(14,2) DEFAULT NULL,
  `tanggal_buka` date DEFAULT NULL,
  `pemilihan_mesin` enum('manual','otomatis') NOT NULL DEFAULT 'manual' COMMENT 'manual = customer/kasir pilih mesin sendiri; otomatis = sistem alokasi mesin otomatis (antrian dinamis kalau penuh)',
  `winpay_aktif` tinyint(1) NOT NULL DEFAULT 0,
  `bayar_cash_aktif` tinyint(1) NOT NULL DEFAULT 1,
  `bayar_qris_aktif` tinyint(1) NOT NULL DEFAULT 0,
  `tukar_poin_aktif` tinyint(1) NOT NULL DEFAULT 1,
  `mdr_winpay_persen` decimal(5,3) DEFAULT NULL,
  `nilai_per_poin` decimal(10,2) NOT NULL DEFAULT 10.00,
  `status` enum('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `modal_investasi` decimal(14,2) DEFAULT NULL COMMENT 'Total modal investasi cabang (Rp), diisi owner'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `coa`
--

CREATE TABLE `coa` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `parent_id` bigint(20) UNSIGNED DEFAULT NULL,
  `belanja_kasir` tinyint(1) NOT NULL DEFAULT 0,
  `belanja_manager` tinyint(1) NOT NULL DEFAULT 0,
  `belanja_owner` tinyint(1) NOT NULL DEFAULT 0,
  `kode` varchar(20) NOT NULL,
  `nama` varchar(100) NOT NULL,
  `tipe` enum('pendapatan','beban','aset','kewajiban','modal') NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `detail_transaksi`
--

CREATE TABLE `detail_transaksi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `item_tipe` enum('jasa','barang') NOT NULL,
  `layanan_id` bigint(20) UNSIGNED DEFAULT NULL,
  `barang_id` bigint(20) UNSIGNED DEFAULT NULL,
  `mesin_id` bigint(20) UNSIGNED DEFAULT NULL,
  `antrian_mesin_id` bigint(20) UNSIGNED DEFAULT NULL COMMENT 'Mesin yang dijanjikan (antrian terkunci). NULL = tidak sedang antre.',
  `antrian_urutan` int(11) DEFAULT NULL COMMENT 'Urutan di antrian mesin tsb (kecil = duluan). Bisa digeser kasir.',
  `antrian_masuk` datetime DEFAULT NULL COMMENT 'Waktu masuk antrian (konfirmasi bayar / selesai cuci). Acuan FIFO saat tata ulang.',
  `nama_item` varchar(100) NOT NULL,
  `harga_satuan` decimal(12,2) NOT NULL,
  `qty` decimal(8,2) NOT NULL,
  `subtotal` decimal(12,2) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `iot_log`
--

CREATE TABLE `iot_log` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `mesin_id` bigint(20) UNSIGNED NOT NULL,
  `command_key` varchar(40) DEFAULT NULL,
  `sukses` tinyint(1) NOT NULL DEFAULT 0,
  `pesan_error` varchar(255) DEFAULT NULL,
  `transaksi_id` bigint(20) UNSIGNED DEFAULT NULL,
  `waktu` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `jadwal_shift`
--

CREATE TABLE `jadwal_shift` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `hari` tinyint(3) UNSIGNED NOT NULL COMMENT '1=Senin..7=Minggu',
  `shift_part_id` bigint(20) UNSIGNED NOT NULL,
  `slot` tinyint(3) UNSIGNED NOT NULL DEFAULT 1 COMMENT '1..3',
  `karyawan_id` bigint(20) UNSIGNED DEFAULT NULL COMMENT 'NULL = kosong',
  `berlaku_mulai` date NOT NULL,
  `dibuat_oleh` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `jatah_cuci_pakai`
--

CREATE TABLE `jatah_cuci_pakai` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `minggu_mulai` date NOT NULL COMMENT 'Senin minggu pemakaian',
  `nilai_order` decimal(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Harga normal cuci + kering',
  `nominal` decimal(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Bagian yang ditanggung jatah',
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `karyawan`
--

CREATE TABLE `karyawan` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `role_id` bigint(20) UNSIGNED NOT NULL,
  `nama` varchar(100) NOT NULL,
  `telepon` varchar(20) DEFAULT NULL COMMENT 'Nomor HP karyawan',
  `username` varchar(50) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `password_diubah_at` datetime(3) DEFAULT NULL,
  `status` enum('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  `jatah_cuci_mingguan` int(11) NOT NULL DEFAULT 20000 COMMENT 'Jatah cuci per minggu (Rp), khusus role kasir; 0 = tidak dapat',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `kas_besar`
--

CREATE TABLE `kas_besar` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `transfer_id` bigint(20) UNSIGNED DEFAULT NULL,
  `tanggal` datetime NOT NULL,
  `jenis` enum('masuk','keluar') NOT NULL,
  `coa_id` bigint(20) UNSIGNED NOT NULL,
  `nominal` decimal(12,2) NOT NULL,
  `sumber` enum('setor_penjualan','reimburse','opex','akrual','biaya_loyalty','distribusi','winpay_mdr','winpay_titip','winpay_tarik') NOT NULL,
  `ref_cabang_id` bigint(20) UNSIGNED DEFAULT NULL,
  `bukti_url` varchar(255) DEFAULT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `keterangan` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `kas_kecil`
--

CREATE TABLE `kas_kecil` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `tanggal` datetime NOT NULL,
  `akun` enum('cash','gopay') NOT NULL,
  `jenis` enum('masuk','keluar') NOT NULL,
  `jenis_mutasi` enum('modal','pendapatan','konversi','belanja_ops','setor','reimburse','biaya_loyalty') NOT NULL,
  `coa_id` bigint(20) UNSIGNED DEFAULT NULL,
  `ref_transaksi_id` bigint(20) UNSIGNED DEFAULT NULL,
  `ref_detail_transaksi_id` bigint(20) UNSIGNED DEFAULT NULL,
  `transfer_id` bigint(20) UNSIGNED DEFAULT NULL,
  `qty` decimal(8,2) DEFAULT NULL,
  `harga_satuan` decimal(12,2) DEFAULT NULL,
  `nominal` decimal(12,2) NOT NULL,
  `metode_asal` enum('cash','qris','kiosk') DEFAULT NULL,
  `bukti_url` varchar(255) DEFAULT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `keterangan` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `keranjang`
--

CREATE TABLE `keranjang` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `urutan` int(11) NOT NULL,
  `kode` varchar(20) NOT NULL,
  `status` enum('kosong','terpakai') NOT NULL DEFAULT 'kosong',
  `transaksi_aktif_id` bigint(20) UNSIGNED DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `layanan`
--

CREATE TABLE `layanan` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `coa_id` bigint(20) UNSIGNED NOT NULL,
  `nama_paket` varchar(100) NOT NULL,
  `deskripsi` varchar(255) DEFAULT NULL COMMENT 'Catatan layanan (Perubahan #59)',
  `kategori` enum('cuci','kering','drop_off','lipat','setrika_lipat','antar','antar_jemput','jemput') NOT NULL,
  `satuan_hitung` enum('per_load','per_kg','per_km') NOT NULL,
  `harga` decimal(12,2) NOT NULL,
  `harga_promo` decimal(12,2) DEFAULT NULL,
  `berat_maks` decimal(6,2) DEFAULT NULL COMMENT 'Batas berat atas (kg) untuk tier harga kategori cuci. NULL = tanpa batas (tier terbesar).',
  `durasi_menit` int(11) DEFAULT NULL,
  `pakai_mesin` tinyint(1) NOT NULL DEFAULT 0,
  `is_promo` tinyint(1) NOT NULL DEFAULT 0,
  `jenis_promo` enum('gratis_cuci_pelanggan_baru','gratis_cuci_jumat_berkah') DEFAULT NULL,
  `tanggal_mulai` date DEFAULT NULL,
  `tanggal_selesai` date DEFAULT NULL,
  `status` enum('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mesin`
--

CREATE TABLE `mesin` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `kode_mesin` varchar(30) NOT NULL,
  `nama_mesin` varchar(50) NOT NULL,
  `tipe` enum('washer','dryer','exaust_fan') NOT NULL,
  `kapasitas_kg` decimal(6,2) NOT NULL,
  `merk` varchar(50) DEFAULT NULL,
  `model` varchar(50) DEFAULT NULL,
  `sn` varchar(50) DEFAULT NULL,
  `command` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`command`)),
  `total_cycle` int(11) NOT NULL DEFAULT 0,
  `status` enum('aktif','jalan','maintenance','nonaktif') NOT NULL DEFAULT 'aktif',
  `keterangan` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `iot_provider` enum('tuya','hallo','bypass') NOT NULL DEFAULT 'bypass',
  `iot_trigger` enum('cloud','local') NOT NULL DEFAULT 'cloud',
  `tuya_device_id` varchar(64) DEFAULT NULL,
  `iot_local_ip` varchar(15) DEFAULT NULL,
  `iot_local_key` varchar(32) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mesin_log_manual`
--

CREATE TABLE `mesin_log_manual` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `mesin_id` bigint(20) UNSIGNED NOT NULL,
  `jenis_aksi` enum('trigger_manual','restart_proses','start_alarm','ubah_antrian','resume_kering') NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED DEFAULT NULL,
  `command` varchar(40) DEFAULT NULL,
  `alasan` varchar(255) NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED DEFAULT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mesin_usage`
--

CREATE TABLE `mesin_usage` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `mesin_id` bigint(20) UNSIGNED NOT NULL,
  `detail_transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `waktu_mulai` datetime NOT NULL,
  `waktu_selesai` datetime DEFAULT NULL,
  `cycle` int(11) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pelanggan`
--

CREATE TABLE `pelanggan` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `nama` varchar(100) NOT NULL,
  `telepon` varchar(20) NOT NULL,
  `alamat` varchar(255) DEFAULT NULL,
  `point` int(11) NOT NULL DEFAULT 0,
  `point_terpakai` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `login_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `last_login` datetime DEFAULT NULL,
  `last_lat` decimal(10,7) DEFAULT NULL,
  `last_lng` decimal(10,7) DEFAULT NULL,
  `frekuensi_kedatangan` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pembayaran_qris`
--

CREATE TABLE `pembayaran_qris` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `pelanggan_id` bigint(20) UNSIGNED NOT NULL,
  `partner_reference_no` varchar(50) NOT NULL COMMENT 'ID referensi dari sistem kita, dikirim ke Winpay',
  `kode_bayar` char(4) DEFAULT NULL COMMENT 'Kode bayar 4 digit buat tablet kiosk dinding (public/kiosk/)',
  `contract_id` varchar(100) DEFAULT NULL COMMENT 'Referensi internal Winpay, dibalikin pas generate',
  `amount` decimal(14,2) NOT NULL,
  `status` enum('pending','paid','expired','canceled','failed') NOT NULL DEFAULT 'pending',
  `qr_url` text DEFAULT NULL,
  `qr_content` text DEFAULT NULL,
  `expired_at` datetime DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `dibuat_oleh_karyawan_id` bigint(20) UNSIGNED DEFAULT NULL COMMENT 'Kasir yang generate (NULL kalau dari customer app sendiri)',
  `raw_generate_response` text DEFAULT NULL COMMENT 'JSON mentah response generate dari Winpay, buat debug',
  `raw_callback_payload` text DEFAULT NULL COMMENT 'JSON mentah payload callback terakhir dari Winpay, buat debug',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pembayaran_qris_transaksi`
--

CREATE TABLE `pembayaran_qris_transaksi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `pembayaran_qris_id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `role`
--

CREATE TABLE `role` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `nama_role` varchar(20) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `shift_part`
--

CREATE TABLE `shift_part` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `shift` tinyint(3) UNSIGNED NOT NULL COMMENT 'Nomor shift (1,2,3,..)',
  `kode` varchar(10) NOT NULL COMMENT 'mis. 1A, 1B, 2A',
  `nama` varchar(30) NOT NULL COMMENT 'mis. Pagi, Siang',
  `jam_mulai` time NOT NULL,
  `jam_selesai` time NOT NULL COMMENT '24:00:00 = tengah malam',
  `hari_berlaku` varchar(7) NOT NULL DEFAULT '1234567' COMMENT '1=Senin..7=Minggu',
  `status` enum('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `status_master`
--

CREATE TABLE `status_master` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `kode` varchar(40) NOT NULL,
  `nama` varchar(60) NOT NULL,
  `urutan` int(11) NOT NULL,
  `dipicu_kategori` varchar(40) DEFAULT NULL,
  `is_iot` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `stok_mutasi`
--

CREATE TABLE `stok_mutasi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `barang_id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `jenis` enum('masuk','keluar') NOT NULL,
  `qty` int(11) NOT NULL,
  `ref_tipe` enum('pembelian','penjualan','penyesuaian') NOT NULL,
  `ref_id` bigint(20) UNSIGNED DEFAULT NULL,
  `stok_sebelum` int(11) NOT NULL,
  `stok_sesudah` int(11) NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `waktu` datetime NOT NULL,
  `keterangan` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transaksi`
--

CREATE TABLE `transaksi` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `pelanggan_id` bigint(20) UNSIGNED NOT NULL,
  `kasir_id` bigint(20) UNSIGNED DEFAULT NULL,
  `keranjang_id` bigint(20) UNSIGNED DEFAULT NULL,
  `kode_antrian` varchar(30) DEFAULT NULL,
  `status_terakhir_id` bigint(20) UNSIGNED DEFAULT NULL,
  `no_invoice` varchar(30) NOT NULL,
  `tanggal` datetime NOT NULL,
  `berat_kg` decimal(6,2) DEFAULT NULL,
  `alamat_antar` varchar(255) DEFAULT NULL,
  `subtotal` decimal(12,2) NOT NULL DEFAULT 0.00,
  `diskon` decimal(12,2) NOT NULL DEFAULT 0.00,
  `poin_dipakai` int(11) DEFAULT NULL,
  `poin_didapat` int(11) DEFAULT NULL,
  `total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `metode_bayar` enum('cash','qris','kiosk') NOT NULL,
  `status_bayar` enum('belum','lunas') NOT NULL DEFAULT 'belum',
  `bayar_saat_ambil` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = diproses dulu, dibayar saat cucian diambil (kasir)',
  `tanggal_bayar` datetime DEFAULT NULL COMMENT 'Waktu uang diterima (lunas). Acuan laporan omzet.',
  `status_setor` enum('belum_setor','sudah_setor') NOT NULL DEFAULT 'belum_setor',
  `posisi_cucian_manual` enum('mesin','keranjang') DEFAULT NULL,
  `ditahan` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = ditahan owner, keluar dari antrian mesin',
  `ditahan_at` datetime DEFAULT NULL,
  `ditahan_alasan` varchar(255) DEFAULT NULL,
  `ditahan_oleh` bigint(20) UNSIGNED DEFAULT NULL,
  `transfer_id` bigint(20) UNSIGNED DEFAULT NULL,
  `sumber_pesan` enum('customer_app','kasir') NOT NULL DEFAULT 'kasir',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transaksi_hapus_log`
--

CREATE TABLE `transaksi_hapus_log` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL COMMENT 'id lama (baris transaksi sudah dihapus)',
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `no_invoice` varchar(30) NOT NULL,
  `pelanggan_id` bigint(20) UNSIGNED DEFAULT NULL,
  `total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status_bayar` varchar(20) DEFAULT NULL,
  `sudah_setor` tinyint(1) NOT NULL DEFAULT 0,
  `koreksi_kas_besar` decimal(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Nilai koreksi pendapatan di Kas Besar (sudah disetor)',
  `alasan` varchar(255) NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL COMMENT 'owner yang menghapus',
  `snapshot` longtext DEFAULT NULL COMMENT 'JSON header + item + riwayat status',
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transaksi_status_log`
--

CREATE TABLE `transaksi_status_log` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `transaksi_id` bigint(20) UNSIGNED NOT NULL,
  `status_id` bigint(20) UNSIGNED NOT NULL,
  `karyawan_id` bigint(20) UNSIGNED DEFAULT NULL,
  `mesin_id` bigint(20) UNSIGNED DEFAULT NULL,
  `waktu` datetime NOT NULL,
  `keterangan` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transfer`
--

CREATE TABLE `transfer` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `cabang_id` bigint(20) UNSIGNED NOT NULL,
  `tanggal` datetime NOT NULL,
  `id_transfer` varchar(30) NOT NULL,
  `arah` enum('kasir_ke_management','management_ke_kasir') NOT NULL,
  `nominal_transfer` decimal(12,2) NOT NULL,
  `total_pendapatan` decimal(12,2) NOT NULL DEFAULT 0.00,
  `total_reimburse` decimal(12,2) NOT NULL DEFAULT 0.00,
  `saldo_gopay_snapshot` decimal(12,2) NOT NULL DEFAULT 0.00,
  `jumlah_transaksi` int(11) NOT NULL DEFAULT 0,
  `bukti_url` varchar(255) DEFAULT NULL,
  `karyawan_id` bigint(20) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `absensi`
--
ALTER TABLE `absensi`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_absensi_karyawan` (`karyawan_id`,`tanggal`),
  ADD KEY `idx_absensi_cabang` (`cabang_id`,`tanggal`);

--
-- Indexes for table `absensi_koreksi`
--
ALTER TABLE `absensi_koreksi`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_akoreksi_absensi` (`absensi_id`),
  ADD KEY `idx_akoreksi_status` (`status`),
  ADD KEY `fk_akoreksi_pengaju` (`diajukan_oleh`);

--
-- Indexes for table `barang`
--
ALTER TABLE `barang`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_barang_cabang` (`cabang_id`),
  ADD KEY `fk_barang_coa` (`coa_id`);

--
-- Indexes for table `barang_foto`
--
ALTER TABLE `barang_foto`
  ADD PRIMARY KEY (`barang_id`);

--
-- Indexes for table `cabang`
--
ALTER TABLE `cabang`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_cabang_kode` (`kode`);

--
-- Indexes for table `coa`
--
ALTER TABLE `coa`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_coa_kode` (`kode`),
  ADD KEY `fk_coa_parent` (`parent_id`);

--
-- Indexes for table `detail_transaksi`
--
ALTER TABLE `detail_transaksi`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_detail_transaksi` (`transaksi_id`),
  ADD KEY `fk_detail_layanan` (`layanan_id`),
  ADD KEY `fk_detail_barang` (`barang_id`),
  ADD KEY `fk_detail_mesin` (`mesin_id`),
  ADD KEY `idx_dt_antrian` (`antrian_mesin_id`,`antrian_urutan`);

--
-- Indexes for table `iot_log`
--
ALTER TABLE `iot_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_iotlog_mesin` (`mesin_id`,`waktu`),
  ADD KEY `fk_iotlog_transaksi` (`transaksi_id`);

--
-- Indexes for table `jadwal_shift`
--
ALTER TABLE `jadwal_shift`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_jadwal_slot` (`cabang_id`,`hari`,`shift_part_id`,`slot`,`berlaku_mulai`),
  ADD KEY `idx_jadwal_karyawan` (`karyawan_id`),
  ADD KEY `fk_jadwal_part` (`shift_part_id`);

--
-- Indexes for table `jatah_cuci_pakai`
--
ALTER TABLE `jatah_cuci_pakai`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_jatah_transaksi` (`transaksi_id`),
  ADD KEY `idx_jatah_karyawan_minggu` (`karyawan_id`,`minggu_mulai`),
  ADD KEY `fk_jatah_cabang` (`cabang_id`);

--
-- Indexes for table `karyawan`
--
ALTER TABLE `karyawan`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_karyawan_username` (`username`),
  ADD KEY `idx_karyawan_cabang` (`cabang_id`),
  ADD KEY `fk_karyawan_role` (`role_id`);

--
-- Indexes for table `kas_besar`
--
ALTER TABLE `kas_besar`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_kasbesar_tanggal` (`tanggal`),
  ADD KEY `idx_kasbesar_transfer` (`transfer_id`),
  ADD KEY `fk_kasbesar_coa` (`coa_id`),
  ADD KEY `fk_kasbesar_cabang` (`ref_cabang_id`),
  ADD KEY `fk_kasbesar_karyawan` (`karyawan_id`);

--
-- Indexes for table `kas_kecil`
--
ALTER TABLE `kas_kecil`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_kaskecil_cabang` (`cabang_id`,`tanggal`),
  ADD KEY `idx_kaskecil_akun` (`cabang_id`,`akun`),
  ADD KEY `fk_kaskecil_coa` (`coa_id`),
  ADD KEY `fk_kaskecil_trx` (`ref_transaksi_id`),
  ADD KEY `fk_kaskecil_detail` (`ref_detail_transaksi_id`),
  ADD KEY `fk_kaskecil_transfer` (`transfer_id`),
  ADD KEY `fk_kaskecil_karyawan` (`karyawan_id`);

--
-- Indexes for table `keranjang`
--
ALTER TABLE `keranjang`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_keranjang_kode` (`kode`),
  ADD KEY `idx_keranjang_cabang` (`cabang_id`),
  ADD KEY `fk_keranjang_txaktif` (`transaksi_aktif_id`);

--
-- Indexes for table `layanan`
--
ALTER TABLE `layanan`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_layanan_cabang` (`cabang_id`),
  ADD KEY `fk_layanan_coa` (`coa_id`);

--
-- Indexes for table `mesin`
--
ALTER TABLE `mesin`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_mesin_kode` (`kode_mesin`),
  ADD KEY `idx_mesin_cabang` (`cabang_id`);

--
-- Indexes for table `mesin_log_manual`
--
ALTER TABLE `mesin_log_manual`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_logmanual_mesin` (`mesin_id`,`created_at`),
  ADD KEY `idx_logmanual_cabang` (`cabang_id`,`created_at`),
  ADD KEY `fk_logmanual_transaksi` (`transaksi_id`),
  ADD KEY `fk_logmanual_karyawan` (`karyawan_id`);

--
-- Indexes for table `mesin_usage`
--
ALTER TABLE `mesin_usage`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_usage_mesin` (`mesin_id`,`waktu_mulai`),
  ADD KEY `fk_usage_detail` (`detail_transaksi_id`),
  ADD KEY `fk_usage_trx` (`transaksi_id`);

--
-- Indexes for table `pelanggan`
--
ALTER TABLE `pelanggan`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pelanggan_cabang_telp` (`cabang_id`,`telepon`);

--
-- Indexes for table `pembayaran_qris`
--
ALTER TABLE `pembayaran_qris`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pqris_partner_ref` (`partner_reference_no`),
  ADD KEY `idx_pqris_contract` (`contract_id`),
  ADD KEY `idx_pqris_status` (`status`),
  ADD KEY `idx_pqris_pelanggan` (`pelanggan_id`),
  ADD KEY `fk_pqris_cabang` (`cabang_id`),
  ADD KEY `fk_pqris_karyawan` (`dibuat_oleh_karyawan_id`),
  ADD KEY `idx_pqris_kode_lookup` (`cabang_id`,`kode_bayar`,`status`);

--
-- Indexes for table `pembayaran_qris_transaksi`
--
ALTER TABLE `pembayaran_qris_transaksi`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pqristrx` (`pembayaran_qris_id`,`transaksi_id`),
  ADD KEY `fk_pqristrx_transaksi` (`transaksi_id`);

--
-- Indexes for table `role`
--
ALTER TABLE `role`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_role_nama` (`nama_role`);

--
-- Indexes for table `shift_part`
--
ALTER TABLE `shift_part`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_shift_part_kode` (`cabang_id`,`kode`);

--
-- Indexes for table `status_master`
--
ALTER TABLE `status_master`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_status_kode` (`kode`);

--
-- Indexes for table `stok_mutasi`
--
ALTER TABLE `stok_mutasi`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_stok_barang` (`barang_id`,`waktu`),
  ADD KEY `fk_stok_cabang` (`cabang_id`),
  ADD KEY `fk_stok_karyawan` (`karyawan_id`);

--
-- Indexes for table `transaksi`
--
ALTER TABLE `transaksi`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_transaksi_invoice` (`no_invoice`),
  ADD KEY `idx_transaksi_cabang` (`cabang_id`),
  ADD KEY `idx_transaksi_pelanggan` (`pelanggan_id`),
  ADD KEY `idx_transaksi_setor` (`cabang_id`,`status_setor`,`tanggal`),
  ADD KEY `fk_transaksi_kasir` (`kasir_id`),
  ADD KEY `fk_transaksi_keranjang` (`keranjang_id`),
  ADD KEY `fk_transaksi_status` (`status_terakhir_id`),
  ADD KEY `fk_transaksi_transfer` (`transfer_id`),
  ADD KEY `idx_transaksi_tgl_bayar` (`cabang_id`,`tanggal_bayar`);

--
-- Indexes for table `transaksi_hapus_log`
--
ALTER TABLE `transaksi_hapus_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_hapus_cabang` (`cabang_id`,`created_at`),
  ADD KEY `idx_hapus_invoice` (`no_invoice`);

--
-- Indexes for table `transaksi_status_log`
--
ALTER TABLE `transaksi_status_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_statuslog_transaksi` (`transaksi_id`,`waktu`),
  ADD KEY `fk_statuslog_status` (`status_id`),
  ADD KEY `fk_statuslog_karyawan` (`karyawan_id`),
  ADD KEY `fk_statuslog_mesin` (`mesin_id`);

--
-- Indexes for table `transfer`
--
ALTER TABLE `transfer`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_transfer_idtransfer` (`id_transfer`),
  ADD KEY `idx_transfer_cabang` (`cabang_id`),
  ADD KEY `fk_transfer_karyawan` (`karyawan_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `absensi`
--
ALTER TABLE `absensi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `absensi_koreksi`
--
ALTER TABLE `absensi_koreksi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `barang`
--
ALTER TABLE `barang`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `cabang`
--
ALTER TABLE `cabang`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `coa`
--
ALTER TABLE `coa`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `detail_transaksi`
--
ALTER TABLE `detail_transaksi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `iot_log`
--
ALTER TABLE `iot_log`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `jadwal_shift`
--
ALTER TABLE `jadwal_shift`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `jatah_cuci_pakai`
--
ALTER TABLE `jatah_cuci_pakai`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `karyawan`
--
ALTER TABLE `karyawan`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kas_besar`
--
ALTER TABLE `kas_besar`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `kas_kecil`
--
ALTER TABLE `kas_kecil`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `keranjang`
--
ALTER TABLE `keranjang`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `layanan`
--
ALTER TABLE `layanan`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mesin`
--
ALTER TABLE `mesin`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mesin_log_manual`
--
ALTER TABLE `mesin_log_manual`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mesin_usage`
--
ALTER TABLE `mesin_usage`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pelanggan`
--
ALTER TABLE `pelanggan`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pembayaran_qris`
--
ALTER TABLE `pembayaran_qris`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `pembayaran_qris_transaksi`
--
ALTER TABLE `pembayaran_qris_transaksi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `role`
--
ALTER TABLE `role`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `shift_part`
--
ALTER TABLE `shift_part`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `status_master`
--
ALTER TABLE `status_master`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `stok_mutasi`
--
ALTER TABLE `stok_mutasi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transaksi`
--
ALTER TABLE `transaksi`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transaksi_hapus_log`
--
ALTER TABLE `transaksi_hapus_log`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transaksi_status_log`
--
ALTER TABLE `transaksi_status_log`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transfer`
--
ALTER TABLE `transfer`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `absensi`
--
ALTER TABLE `absensi`
  ADD CONSTRAINT `fk_absensi_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_absensi_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`);

--
-- Constraints for table `absensi_koreksi`
--
ALTER TABLE `absensi_koreksi`
  ADD CONSTRAINT `fk_akoreksi_absensi` FOREIGN KEY (`absensi_id`) REFERENCES `absensi` (`id`),
  ADD CONSTRAINT `fk_akoreksi_pengaju` FOREIGN KEY (`diajukan_oleh`) REFERENCES `karyawan` (`id`);

--
-- Constraints for table `barang`
--
ALTER TABLE `barang`
  ADD CONSTRAINT `fk_barang_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_barang_coa` FOREIGN KEY (`coa_id`) REFERENCES `coa` (`id`);

--
-- Constraints for table `barang_foto`
--
ALTER TABLE `barang_foto`
  ADD CONSTRAINT `fk_barang_foto_barang` FOREIGN KEY (`barang_id`) REFERENCES `barang` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `coa`
--
ALTER TABLE `coa`
  ADD CONSTRAINT `fk_coa_parent` FOREIGN KEY (`parent_id`) REFERENCES `coa` (`id`);

--
-- Constraints for table `detail_transaksi`
--
ALTER TABLE `detail_transaksi`
  ADD CONSTRAINT `fk_detail_barang` FOREIGN KEY (`barang_id`) REFERENCES `barang` (`id`),
  ADD CONSTRAINT `fk_detail_layanan` FOREIGN KEY (`layanan_id`) REFERENCES `layanan` (`id`),
  ADD CONSTRAINT `fk_detail_mesin` FOREIGN KEY (`mesin_id`) REFERENCES `mesin` (`id`),
  ADD CONSTRAINT `fk_detail_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`),
  ADD CONSTRAINT `fk_dt_antrian_mesin` FOREIGN KEY (`antrian_mesin_id`) REFERENCES `mesin` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `iot_log`
--
ALTER TABLE `iot_log`
  ADD CONSTRAINT `fk_iotlog_mesin` FOREIGN KEY (`mesin_id`) REFERENCES `mesin` (`id`),
  ADD CONSTRAINT `fk_iotlog_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `jadwal_shift`
--
ALTER TABLE `jadwal_shift`
  ADD CONSTRAINT `fk_jadwal_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_jadwal_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_jadwal_part` FOREIGN KEY (`shift_part_id`) REFERENCES `shift_part` (`id`);

--
-- Constraints for table `jatah_cuci_pakai`
--
ALTER TABLE `jatah_cuci_pakai`
  ADD CONSTRAINT `fk_jatah_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_jatah_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_jatah_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `karyawan`
--
ALTER TABLE `karyawan`
  ADD CONSTRAINT `fk_karyawan_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_karyawan_role` FOREIGN KEY (`role_id`) REFERENCES `role` (`id`);

--
-- Constraints for table `kas_besar`
--
ALTER TABLE `kas_besar`
  ADD CONSTRAINT `fk_kasbesar_cabang` FOREIGN KEY (`ref_cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_kasbesar_coa` FOREIGN KEY (`coa_id`) REFERENCES `coa` (`id`),
  ADD CONSTRAINT `fk_kasbesar_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_kasbesar_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `transfer` (`id`);

--
-- Constraints for table `kas_kecil`
--
ALTER TABLE `kas_kecil`
  ADD CONSTRAINT `fk_kaskecil_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_kaskecil_coa` FOREIGN KEY (`coa_id`) REFERENCES `coa` (`id`),
  ADD CONSTRAINT `fk_kaskecil_detail` FOREIGN KEY (`ref_detail_transaksi_id`) REFERENCES `detail_transaksi` (`id`),
  ADD CONSTRAINT `fk_kaskecil_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_kaskecil_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `transfer` (`id`),
  ADD CONSTRAINT `fk_kaskecil_trx` FOREIGN KEY (`ref_transaksi_id`) REFERENCES `transaksi` (`id`);

--
-- Constraints for table `keranjang`
--
ALTER TABLE `keranjang`
  ADD CONSTRAINT `fk_keranjang_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_keranjang_txaktif` FOREIGN KEY (`transaksi_aktif_id`) REFERENCES `transaksi` (`id`);

--
-- Constraints for table `layanan`
--
ALTER TABLE `layanan`
  ADD CONSTRAINT `fk_layanan_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_layanan_coa` FOREIGN KEY (`coa_id`) REFERENCES `coa` (`id`);

--
-- Constraints for table `mesin`
--
ALTER TABLE `mesin`
  ADD CONSTRAINT `fk_mesin_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`);

--
-- Constraints for table `mesin_log_manual`
--
ALTER TABLE `mesin_log_manual`
  ADD CONSTRAINT `fk_logmanual_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_logmanual_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_logmanual_mesin` FOREIGN KEY (`mesin_id`) REFERENCES `mesin` (`id`),
  ADD CONSTRAINT `fk_logmanual_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `mesin_usage`
--
ALTER TABLE `mesin_usage`
  ADD CONSTRAINT `fk_usage_detail` FOREIGN KEY (`detail_transaksi_id`) REFERENCES `detail_transaksi` (`id`),
  ADD CONSTRAINT `fk_usage_mesin` FOREIGN KEY (`mesin_id`) REFERENCES `mesin` (`id`),
  ADD CONSTRAINT `fk_usage_trx` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`);

--
-- Constraints for table `pelanggan`
--
ALTER TABLE `pelanggan`
  ADD CONSTRAINT `fk_pelanggan_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`);

--
-- Constraints for table `pembayaran_qris`
--
ALTER TABLE `pembayaran_qris`
  ADD CONSTRAINT `fk_pqris_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_pqris_karyawan` FOREIGN KEY (`dibuat_oleh_karyawan_id`) REFERENCES `karyawan` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_pqris_pelanggan` FOREIGN KEY (`pelanggan_id`) REFERENCES `pelanggan` (`id`);

--
-- Constraints for table `pembayaran_qris_transaksi`
--
ALTER TABLE `pembayaran_qris_transaksi`
  ADD CONSTRAINT `fk_pqristrx_pqris` FOREIGN KEY (`pembayaran_qris_id`) REFERENCES `pembayaran_qris` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_pqristrx_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`);

--
-- Constraints for table `shift_part`
--
ALTER TABLE `shift_part`
  ADD CONSTRAINT `fk_shift_part_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`);

--
-- Constraints for table `stok_mutasi`
--
ALTER TABLE `stok_mutasi`
  ADD CONSTRAINT `fk_stok_barang` FOREIGN KEY (`barang_id`) REFERENCES `barang` (`id`),
  ADD CONSTRAINT `fk_stok_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_stok_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`);

--
-- Constraints for table `transaksi`
--
ALTER TABLE `transaksi`
  ADD CONSTRAINT `fk_transaksi_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_transaksi_kasir` FOREIGN KEY (`kasir_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_transaksi_keranjang` FOREIGN KEY (`keranjang_id`) REFERENCES `keranjang` (`id`),
  ADD CONSTRAINT `fk_transaksi_pelanggan` FOREIGN KEY (`pelanggan_id`) REFERENCES `pelanggan` (`id`),
  ADD CONSTRAINT `fk_transaksi_status` FOREIGN KEY (`status_terakhir_id`) REFERENCES `status_master` (`id`),
  ADD CONSTRAINT `fk_transaksi_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `transfer` (`id`);

--
-- Constraints for table `transaksi_status_log`
--
ALTER TABLE `transaksi_status_log`
  ADD CONSTRAINT `fk_statuslog_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`),
  ADD CONSTRAINT `fk_statuslog_mesin` FOREIGN KEY (`mesin_id`) REFERENCES `mesin` (`id`),
  ADD CONSTRAINT `fk_statuslog_status` FOREIGN KEY (`status_id`) REFERENCES `status_master` (`id`),
  ADD CONSTRAINT `fk_statuslog_transaksi` FOREIGN KEY (`transaksi_id`) REFERENCES `transaksi` (`id`);

--
-- Constraints for table `transfer`
--
ALTER TABLE `transfer`
  ADD CONSTRAINT `fk_transfer_cabang` FOREIGN KEY (`cabang_id`) REFERENCES `cabang` (`id`),
  ADD CONSTRAINT `fk_transfer_karyawan` FOREIGN KEY (`karyawan_id`) REFERENCES `karyawan` (`id`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;