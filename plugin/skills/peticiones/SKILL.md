---
name: peticiones
description: Muestra las capacidades que ha pedido el agente trader (cuentas, herramientas, datos, mercados que el simulador no permite) y deja que el usuario las acepte, rechace o marque como hechas.
disable-model-invocation: true
allowed-tools: mcp__plugin_dementeking_cryptosim__capability_requests, mcp__plugin_dementeking_cryptosim__resolve_capability_request
---

Vas a enseñar al usuario lo que el agente echa en falta para intentar cosas nuevas. Habla en español.

1. Si no tienes cargadas las herramientas del servidor `cryptosim`, cárgalas con ToolSearch (`+dementeking`). Si no aparecen, explica que el plugin solo funciona en Claude Code con el plugin `dementeking` activado, y para aquí.
2. Llama a `capability_requests`. Si no hay ninguna abierta, díselo y para aquí.
3. Muéstralas de la más pedida a la menos, en texto sencillo (sin tablas: puede estar en el móvil). De cada una: qué pide, cuántas veces y en qué misiones, por qué la necesita y qué haría con ella.
4. Pregunta con AskUserQuestion (multiSelect) si quiere responder a alguna. Para cada una que elija, pregunta qué hacer:
   - "Aceptada": piensa dársela más adelante.
   - "Rechazada": no se le va a dar (pide el motivo en una frase, o usa "Sin motivo").
   - "Hecha": ya está disponible.
   Registra cada respuesta con `resolve_capability_request`.
5. Termina con una línea: las peticiones aceptadas o hechas requieren un cambio en el plugin o en su configuración; recuérdale que puede pedírselo a Claude en Claude Code.

No valores tú si las peticiones son buena idea salvo que el usuario lo pida.
