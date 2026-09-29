---
name: parar
description: Detiene la misión activa del agente trader antes de que termine el plazo.
disable-model-invocation: true
allowed-tools: mcp__plugin_dementeking_cryptosim__mission_status, mcp__plugin_dementeking_cryptosim__stop_mission, mcp__plugin_dementeking_cryptosim__stop_dashboard
---

Vas a detener la misión activa. Habla con el usuario en español.

1. Si no tienes cargadas las herramientas del servidor `cryptosim`, cárgalas con ToolSearch (`+dementeking`). Si no aparecen, díselo al usuario según el caso y para aquí:
   - Si no tienes la herramienta Agent, estás en el chat normal de Claude, no en Claude Code. Explica que este plugin solo funciona en **Claude Code** (la pestaña **Code** de la app de escritorio, la terminal o las extensiones de VS Code y JetBrains), porque el simulador se ejecuta en su ordenador y el agente trabaja en segundo plano; el chat normal no puede arrancarlos. Dile que abra una sesión en la pestaña Code (sirve cualquier carpeta) y escriba `/dementeking:parar`.
   - Si sí la tienes, estás en Claude Code pero el plugin no está cargado: que compruebe en el gestor de plugins que `dementeking` está instalado y activado, y que abra una sesión nueva.

   Llama a `mission_status`. Si no hay ninguna misión activa, díselo al usuario y para aquí.

2. Pregunta con AskUserQuestion qué hacer con la cartera. En la pregunta incluye el valor actual, el objetivo y el tiempo restante:
   - "Cerrar posiciones (Recommended)": vende todo a mercado al precio real, como al terminar una misión.
   - "Dejar la cartera como está": solo detiene la misión y cancela las órdenes.
   - "No detenerla": no hagas nada más.

3. Llama a `stop_mission` con `close_positions` según la respuesta.

4. Si en esta sesión hay un agente `dementeking:trader` trabajando en segundo plano, detenlo con TaskStop. No detengas al revisor (`dementeking:reviewer`): verá que la misión ha terminado y hará su retrospectiva. Si no hay ningún revisor trabajando y la misión llegó a operar, lánzalo en segundo plano con la herramienta Agent (`subagent_type` `dementeking:reviewer`, `description` `Revisor de la misión`, `run_in_background` `true`, `prompt` exactamente `Vigila la misión.`).

5. Cierra el panel web local con `stop_dashboard` (deja de escuchar en localhost). Si el usuario quiere volver a verlo, se abre con `/dementeking:trading` o con la herramienta `start_dashboard`.

6. Resume en una o dos líneas el valor final y cómo quedó la misión, y que el panel se ha cerrado. Recuerda que con `/dementeking:trading` puede empezar otra.
