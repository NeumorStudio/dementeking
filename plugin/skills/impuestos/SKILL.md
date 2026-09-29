---
name: impuestos
description: Exporta a CSV (Excel) las operaciones con dinero real de la cartera de la IA - swaps y puentes con hash, cantidades, valor en USD y EUR y comisiones - y los resultados por posición, como apoyo para la declaración.
disable-model-invocation: true
allowed-tools: mcp__plugin_dementeking_cryptosim__export_taxes
---

Exporta el registro de operaciones reales. Habla en español.

1. Si no tienes cargadas las herramientas del servidor `cryptosim`, cárgalas con ToolSearch (`+dementeking`).
2. Si el usuario ha indicado un año, pásalo como `year`; si no, exporta todo.
3. Llama a `export_taxes` y enseña, en pocas líneas: cuántas operaciones y posiciones hay, el resultado realizado en USD y EUR y las rutas de los dos archivos.
4. Recuerda, en una línea, que es un registro de apoyo y no asesoramiento fiscal: en España cada permuta entre criptomonedas es una ganancia o pérdida patrimonial y Hacienda exige FIFO. Su gestor puede recalcularlo con el archivo de operaciones.
