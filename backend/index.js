require('dotenv').config();
const express = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── DB Pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error al conectar a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conexión EXITOSA a la base de datos PostgreSQL en Aiven!');
    release();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts any Google Drive share/view URL to a direct thumbnail URL.
 * Handles: open?id=, file/d/, uc?id= formats.
 */
function convertDriveUrl(url) {
  if (!url || !url.includes('drive.google.com')) return url;

  const fileMatch = url.match(/\/file\/d\/([^/?&#]+)/);
  if (fileMatch) {
    return `https://drive.google.com/thumbnail?id=${fileMatch[1]}&sz=w1200`;
  }
  const idMatch = url.match(/[?&]id=([^&#]+)/);
  if (idMatch) {
    return `https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w1200`;
  }
  return url;
}

/**
 * Maps a nombre_categoria from the DB to one of the EcoCategory values
 * used by the frontend (organic_food | sustainable_fashion | recycling | renewable_energy | other).
 */
function mapCategory(nombre) {
  if (!nombre) return 'other';
  const n = nombre.toLowerCase();
  if (n.includes('aliment') || n.includes('bebida') || n.includes('orgán') || n.includes('organic')) return 'organic_food';
  if (n.includes('moda') || n.includes('textil') || n.includes('tejido') || n.includes('ropa') || n.includes('fashion')) return 'sustainable_fashion';
  if (n.includes('recicl') || n.includes('2da vida') || n.includes('cartón') || n.includes('carton') || n.includes('residuo')) return 'recycling';
  if (n.includes('energí') || n.includes('energia') || n.includes('solar') || n.includes('transporte ecológ') || n.includes('renovable')) return 'renewable_energy';
  return 'other';
}

/**
 * Extracts a human-readable location string from the raw DB value.
 * tipo_ubicacion values are verbose dropdown options, so we clean them up.
 */
function parseLocation(tipoUbicacion, linkMaps) {
  if (tipoUbicacion) {
    const lower = tipoUbicacion.toLowerCase();
    if (lower.includes('virtual') || lower.includes('negocio virtual')) return 'Negocio Virtual';
    if (lower.includes('punto de entrega')) return 'Punto de Entrega · Bolivia';
    if (lower.includes('punto de venta'))   return 'Punto de Venta · Bolivia';
    if (lower.includes('mi casa'))          return 'Entrega a Domicilio · Bolivia';
  }
  if (linkMaps && !linkMaps.startsWith('http')) {
    // It's a text description, not an actual link — use first 35 chars
    return linkMaps.substring(0, 35).trim();
  }
  return 'Bolivia';
}

/**
 * Infers an impactSummary from the available sustainability fields.
 */
function buildImpactSummary(row) {
  if (row.resuelve_problematica_ambiental) return row.resuelve_problematica_ambiental;
  if (row.actividades_sostenibles)          return row.actividades_sostenibles;
  if (row.descripcion_detallada)             return row.descripcion_detallada.substring(0, 120);
  return '';
}

/**
 * Builds greenSignals from available DB fields.
 * Returns array of { label, value } objects.
 */
function buildGreenSignals(row) {
  const signals = [];
  if (row.tiempo_mercado) {
    signals.push({ label: 'En el mercado', value: row.tiempo_mercado });
  }
  if (row.reduce_empaques) {
    const val = ['si','sí','yes','true'].includes(row.reduce_empaques.toLowerCase()) ? 'Sí' : row.reduce_empaques;
    signals.push({ label: 'Reduce empaques', value: val });
  }
  if (row.horario_atencion) {
    const horario = row.horario_atencion.substring(0, 30).trim();
    signals.push({ label: 'Horario', value: horario });
  }
  return signals;
}

/**
 * Builds impact badges from validaciones_indicadores and validation status.
 */
function buildImpactBadges(row) {
  const badges = [];
  if (['validado', 'activo'].includes((row.estado_validacion ?? '').toLowerCase())) {
    badges.push('Eco Verificado');
  }
  if (row.validaciones_indicadores) {
    const parts = String(row.validaciones_indicadores)
      .split(/[,;|\n]+/)
      .map((b) => b.trim())
      .filter((b) => b.length > 2 && b.length < 60);
    badges.push(...parts.slice(0, 3));
  }
  return badges;
}

/**
 * Maps a raw ecoservices row + joined category row → GreenEnterprise shape.
 */
function mapEnterprise(row) {
  return {
    id:            String(row.id_ecoservice ?? ''),
    name:          (row.nombre_emprendimiento ?? '').trim(),
    description:   (row.descripcion_detallada ?? '').trim(),
    category:      mapCategory(row.nombre_categoria),
    categoryLabel: row.nombre_categoria ?? 'Eco Emprendimiento',
    imageUrl:      convertDriveUrl(row.foto_principal_url ?? ''),
    logoUrl:       '',  // no logo column in DB — frontend will use mock fallback
    location:      parseLocation(row.tipo_ubicacion, row.link_google_maps),
    impactSummary: buildImpactSummary(row),
    greenSignals:  buildGreenSignals(row),
    impactBadges:  buildImpactBadges(row),
    keywords:      [],
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gaia-pacha-backend' });
});

// GET /api/enterprises — list with optional ?category=&search= filters
app.get('/api/enterprises', async (req, res) => {
  try {
    const { search } = req.query;
    const params  = [];
    const clauses = [];

    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const n = params.length;
      clauses.push(`(LOWER(e.nombre_emprendimiento) LIKE $${n} OR LOWER(e.descripcion_detallada) LIKE $${n})`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Join with categorias via studio_contenido (best available link);
    // if that's empty we still get all ecoservices with null category.
    const sql = `
      SELECT
        e.*,
        c.nombre_categoria
      FROM ecoservices e
      LEFT JOIN LATERAL (
        SELECT sc.id_categoria
        FROM studio_contenido sc
        WHERE sc.id_ecoservice = e.id_ecoservice
        LIMIT 1
      ) sc_link ON true
      LEFT JOIN categorias c ON c.id_categoria = sc_link.id_categoria
      ${where}
      ORDER BY e.id_ecoservice
    `;

    const result = await pool.query(sql, params);
    console.log(`[GET /api/enterprises] rows=${result.rows.length}`);

    res.json({
      success: true,
      data:    result.rows.map(mapEnterprise),
      count:   result.rows.length,
    });
  } catch (err) {
    console.error('[GET /api/enterprises] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/enterprises/:id
app.get('/api/enterprises/:id', async (req, res) => {
  try {
    const sql = `
      SELECT e.*, c.nombre_categoria
      FROM ecoservices e
      LEFT JOIN LATERAL (
        SELECT sc.id_categoria FROM studio_contenido sc
        WHERE sc.id_ecoservice = e.id_ecoservice LIMIT 1
      ) sc_link ON true
      LEFT JOIN categorias c ON c.id_categoria = sc_link.id_categoria
      WHERE e.id_ecoservice = $1
    `;
    const result = await pool.query(sql, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Enterprise not found' });
    }

    res.json({ success: true, data: mapEnterprise(result.rows[0]) });
  } catch (err) {
    console.error('[GET /api/enterprises/:id] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gaia Pacha Backend running on http://localhost:${PORT}`);
});

