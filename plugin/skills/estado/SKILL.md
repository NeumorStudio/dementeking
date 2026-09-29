---
name: estado
description: Muestra cómo va la misión del agente trader - progreso, posiciones, últimos movimientos y su última nota. Sirve también desde el móvil con Remote Control.
disable-model-invocation: true
allowed-tools: mcp__plugin_dementeking_cryptosim__status_report
---

Enseña al usuario cómo va la misión. Habla en español.

1. Si no tienes cargadas las herramientas del servidor `cryptosim`, cárgalas con ToolSearch (`+dementeking`). Si no aparecen, explica que el plugin solo funciona en Claude Code con el plugin `dementeking` activado, y para aquí.
2. Llama a `status_report` y muestra su contenido tal cual, sin tablas ni adornos: el usuario puede estar leyéndolo en el móvil.
3. Si la misión está en curso, termina con una línea que diga que puede volver a escribir `/dementeking:estado` cuando quiera. Si ha terminado, recuerda que con `/dementeking:trading` puede empezar otra.

No añadas análisis ni opiniones propias sobre las decisiones del agente salvo que el usuario lo pida.
