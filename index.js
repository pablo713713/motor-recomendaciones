// index.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { obtenerCategoriasPonderadas, obtenerRecomendaciones } = require('./services/recomendacion');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// ENDPOINT 1: Top Categorías del Customer
// ==========================================
app.get('/api/recomendaciones/categorias/:id_customer', async (req, res) => {
    try {
        const idCustomer = parseInt(req.params.id_customer);
        const topCategorias = await obtenerCategoriasPonderadas(idCustomer);
        
        // CORRECCIÓN AQUÍ: Usar cat.id_categoria según la nueva BD
        const topIds = topCategorias.map(cat => cat.id_categoria);
        
        res.json({
            status: "success",
            id_customer: idCustomer,
            categorias_top_ids: topIds
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Error interno del servidor al obtener categorías" });
    }
});

// ==========================================
// ENDPOINT 2: Recomendaciones de Ecoservices (El Algoritmo Principal)
// ==========================================
app.get('/api/recomendaciones/ecoservices/:id_customer', async (req, res) => {
    try {
        const idCustomer = parseInt(req.params.id_customer);
        const recomendacionesIds = await obtenerRecomendaciones(idCustomer);

        res.json({
            status: "success",
            id_customer: idCustomer,
            recomendaciones_ids: recomendacionesIds
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Error interno del servidor al calcular ecoservices" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de recomendaciones corriendo en puerto ${PORT}`);
});