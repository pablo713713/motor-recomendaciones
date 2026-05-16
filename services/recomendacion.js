// services/recomendacion.js
const pool = require('../db');

// Función 1: Obtener las categorías ordenadas del usuario
async function obtenerCategoriasPonderadas(id_customer) {
    // Usamos customer_intereses y su columna score_interes directamente
    const query = `
        SELECT 
            id_categoria,
            score_interes AS puntaje
        FROM customer_intereses
        WHERE id_customer = $1
        ORDER BY score_interes DESC;
    `;
    const { rows } = await pool.query(query, [id_customer]);
    return rows; 
}

// Función 2: El algoritmo de 80/20 para Ecoservices
async function obtenerRecomendaciones(id_customer) {
    // 1. Obtener los gustos del usuario
    const categoriasTop = await obtenerCategoriasPonderadas(id_customer);
    
    // Si no tiene preferencias registradas, retornamos un array vacío (o podrías retornar los más populares)
    if (categoriasTop.length === 0) return [];

    // Convertimos las preferencias a un diccionario rápido: { '1': 50, '3': 14 ... }
    const mapaPuntajes = {};
    categoriasTop.forEach(cat => {
        mapaPuntajes[cat.id_categoria] = cat.puntaje;
    });
    
    // 2. Obtener todos los Ecoservices aprobados y sus categorías
    // Como las categorías están en los productos, hacemos un JOIN y agrupamos (array_agg)
    const negociosQuery = `
        SELECT 
            e.id_ecoservice,
            array_agg(DISTINCT p.id_categoria) AS categorias_ids
        FROM ecoservices e
        LEFT JOIN productos p ON e.id_ecoservice = p.id_ecoservice
        WHERE e.estado_validacion = 'aprobado'
        GROUP BY e.id_ecoservice;
    `;
    const { rows: ecoservicesDisponibles } = await pool.query(negociosQuery);

    // 3. Calcular el "Match Score"
    const candidatosPuntuados = ecoservicesDisponibles.map(negocio => {
        let score = 0;

        // Sumar puntos por categorías coincidentes basadas en los productos del ecoservicio
        if (negocio.categorias_ids && negocio.categorias_ids[0] !== null) {
            negocio.categorias_ids.forEach(catId => {
                if (mapaPuntajes[catId]) {
                    score += mapaPuntajes[catId];
                }
            });
        }

        return { id: negocio.id_ecoservice, score };
    });

    // 4. Ordenar por puntuación (Mayor a menor)
    candidatosPuntuados.sort((a, b) => b.score - a.score);

    // 5. Aplicar 80% Explotación / 20% Exploración
    const BATCH_SIZE = 10;
    const EXPLOITATION_COUNT = 8;
    
    // Si hay menos de 10 negocios, ajustamos los límites para evitar errores
    const limiteExplotacion = Math.min(EXPLOITATION_COUNT, candidatosPuntuados.length);
    const explotacion = candidatosPuntuados.slice(0, limiteExplotacion);
    
    const sobrantes = candidatosPuntuados.slice(limiteExplotacion);
    
    // Mezclar los sobrantes y tomar aleatorios para exploración
    sobrantes.sort(() => 0.5 - Math.random());
    const limiteExploracion = Math.min(BATCH_SIZE - limiteExplotacion, sobrantes.length);
    const exploracion = sobrantes.slice(0, limiteExploracion);

    // 6. Juntar y mezclar el lote final para no hacer predecible el Feed
    const loteFinal = [...explotacion, ...exploracion];
    loteFinal.sort(() => 0.5 - Math.random());

    // Retornar solo el array de IDs
    return loteFinal.map(item => item.id);
}

module.exports = {
    obtenerCategoriasPonderadas,
    obtenerRecomendaciones
};