---
name: trading
description: Configura y lanza una misión. Pregunta primero si es rápida (5-15 min, simulada, con un plan de reglas del cerebro y un ejecutor que entra con todo y deja la venta puesta) o normal (el agente trader con su revisor), después capital, objetivo y tiempo, y abre el panel en directo si el usuario quiere.
disable-model-invocation: true
allowed-tools: Agent, mcp__plugin_dementeking_cryptosim__mission_status, mcp__plugin_dementeking_cryptosim__create_mission, mcp__plugin_dementeking_cryptosim__start_dashboard, mcp__plugin_dementeking_cryptosim__stop_mission, mcp__plugin_dementeking_cryptosim__status_report, mcp__plugin_dementeking_cryptosim__wallet_status, mcp__plugin_dementeking_cryptosim__start_wallet, mcp__plugin_dementeking_cryptosim__strategy_fit, mcp__plugin_dementeking_cryptosim__get_plan
---

Vas a preparar y lanzar una misión. Hay dos tipos, con agentes distintos:
- **Rápida** (simulada de 15 minutos o menos; una simulada tan corta siempre es rápida): el cerebro `dementeking:planner` escribe antes del reloj un plan de reglas para un bloque de 20 misiones de esa clase, y el ejecutor `dementeking:executor` lo aplica: espera el evento del plan, compra con todo y deja puesta la venta en el objetivo. Al terminar, el revisor `dementeking:reviewer` la revisa.
- **Normal** (simulada de más de 15 minutos, o real de cualquier plazo: el modo rápido solo existe en simulación): el agente `dementeking:trader`, con su revisor `dementeking:reviewer` (analiza lo que hace el trader y escribe su memoria).

Habla con el usuario en español. Sigue estos pasos en orden.

## 1. Comprobar el simulador

Las herramientas del servidor MCP `cryptosim` (`mission_status`, `create_mission`, `start_dashboard`, `strategy_fit`, `get_plan`) pueden estar diferidas: si no las tienes cargadas, cárgalas con ToolSearch (`+dementeking`). Si no aparecen, díselo al usuario según el caso y para aquí:
- Si no tienes la herramienta Agent, estás en el chat normal de Claude, no en Claude Code. Explica que este plugin solo funciona en **Claude Code** (la pestaña **Code** de la app de escritorio, la terminal o las extensiones de VS Code y JetBrains), porque el simulador se ejecuta en su ordenador y el agente trabaja en segundo plano; el chat normal no puede arrancarlos. Dile que abra una sesión en la pestaña Code (sirve cualquier carpeta) y escriba `/dementeking:trading`.
- Si sí la tienes, estás en Claude Code pero el plugin no está cargado: que compruebe en el gestor de plugins que `dementeking` está instalado y activado, y que abra una sesión nueva.

Llama a `mission_status`.

## 2. Misión activa

Si hay una misión activa, pregunta con AskUserQuestion qué quiere hacer. En la descripción de las opciones incluye el objetivo, el valor actual y el tiempo restante (o que el reloj aún no ha arrancado):
- "Continuar la misión activa": pregunta solo si quiere abrir el panel (Sí / No) y salta al paso 4. En el paso 5, si `mission_status` dice `missionKind` `rápida` (simulada de 15 minutos o menos), sigue en 5R; si dice `normal` (también una real de 15 minutos), lanza el trader y el revisor en segundo plano (5N.2 y 5N.3), sin la preparación.
- "Empezar una nueva": la actual se cancelará. Sigue en el paso 3 y crea la misión con `replace: true`.
- "Detenerla": pregunta con AskUserQuestion si cerrar las posiciones a mercado o dejar la cartera como está, llama a `stop_mission` con `close_positions` según la respuesta, resume el valor final y para aquí.

## 3. Configurar la misión nueva

Primero, una llamada a AskUserQuestion con una sola pregunta, **¿Rápida (5-15 min) o normal?** (header "Tipo"):
- "Rápida (5-15 min) (Recommended)", con la descripción "Simulada. Una sola compra con todo en un token de pump.fun recién graduado, con la venta puesta en el objetivo. La planifica un cerebro antes del reloj y la ejecuta otro agente". Sigue en el paso 3R.
- "Normal (1 hora a 3 días)", con la descripción "El agente trader decide qué hacer, con un revisor que le prepara lo aprendido. Simulada o con dinero real". Sigue en el paso 3N.

### 3R. Misión rápida (solo simulada)

1. Llama a `strategy_fit` con `market: "graduado"`. En `frontier.horizons` viene, para cada plazo, la P medida de cada objetivo (`byTargetPct`): úsala, redondeada, en las descripciones de abajo. Las cifras de los ejemplos son las de la tabla actual; si la llamada falla, usa esas.
2. Haz una sola llamada a AskUserQuestion con estas cuatro preguntas:
   1. **Capital** (header "Capital"): 10 $, 25 $, 50 $ (Recommended). En la descripción de 10 $: "Los costes fijos restan 3-4 puntos en cada ida y vuelta".
   2. **Tiempo** (header "Tiempo"): 5 min, 10 min (Recommended), 15 min. En la descripción de cada uno, la P de los tres objetivos en ese plazo. Por ejemplo, 10 min: "+25 % ≈35 % · +50 % ≈21 % · ×2 ≈9 %".
   3. **Objetivo** (header "Objetivo"): +25 % (Recommended), +50 %, ×2 (+100 %). En la descripción de cada uno, su P en los tres plazos. Por ejemplo, +25 %: "P ≈24 % a 5 min · ≈35 % a 10 · ≈37 % a 15".
   4. **Panel en directo** (header "Panel"): "Sí, abrir el panel (Recommended)", con la descripción "Arranca en tu ordenador (localhost) una web para ver en directo lo que hace el agente"; o "No".

   El usuario puede escribir otro valor con "Other". Un plazo de más de 15 minutos ya no es una misión rápida: díselo y pregunta solo si prefiere un plazo de 15 min o menos o una misión normal (entonces, paso 3N). Si el capital o el objetivo no son positivos, vuelve a preguntar solo eso.
3. Dile en una línea la P de lo que ha elegido y qué significa, con la cifra de `strategy_fit` para ese plazo y ese objetivo. Por ejemplo: "10 min y +25 %: P ≈35 % en los datos medidos (1 de cada 3). Ninguna misión rápida gana dinero de media: el valor esperado es negativo en todas". Con ×2 a 10 min: "≈9 %, 1 de cada 11". No vuelvas a preguntar: decide el usuario.
4. Crea la misión con `create_mission`: `capital_usd`, `target_pct`, `duration_minutes`, `allocation` `{"solana": 100}` (con el reparto por defecto solo quedarían unos 15 $ en Solana y la compra única sería imposible) y `replace: true` si sustituye a otra. Sin `instructions`: las reglas están en el plan.

### 3N. Misión normal

Primero, una llamada a AskUserQuestion con una sola pregunta, **Modo** (header "Modo"):
- "Simulado (Recommended)": dinero ficticio con precios reales. Sigue en el paso 3A.
- "Real": dinero de verdad de la cartera de la IA. Sigue en el paso 3B.

### 3A. Misión simulada

Haz una sola llamada a AskUserQuestion con estas cuatro preguntas:

1. **Capital inicial** (header "Capital"): 100 $, 1.000 $ (Recommended), 10.000 $.
2. **Objetivo** (header "Objetivo"), expresado como ganancia sobre el capital: +2 %, +5 % (Recommended), +10 %, +25 %.
3. **Tiempo para conseguirlo** (header "Tiempo"): 1 hora, 6 horas, 24 horas (Recommended), 3 días.
4. **Panel en directo** (header "Panel"): "Sí, abrir el panel (Recommended)", con la descripción "Arranca en tu ordenador (localhost) una web para ver en directo lo que hace el agente"; o "No".

El usuario puede escribir otro valor con "Other". Interpreta respuestas libres ("500", "2.500 $", "llegar a 1.300", "+20 %", "90 minutos", "2 días"). Un objetivo en porcentaje se aplica sobre el capital; una cifra absoluta es el valor final que debe alcanzar la cartera. Si algo no tiene sentido (cantidades no positivas, objetivo igual o menor que el capital), vuelve a preguntar solo eso. Si el plazo es de 15 minutos o menos: una misión simulada tan corta siempre es rápida (la opera el ejecutor con el plan del cerebro, no el trader). Díselo en una línea y sigue en el paso 3R.3 con ese capital, objetivo y plazo y el panel que haya elegido, sin las preguntas de enfoque y reparto (la rápida va sin instrucciones y todo en Solana).

Después, en otra llamada a AskUserQuestion, haz dos preguntas:

1. **Instrucciones para el agente** (header "Enfoque"):
   - "Modo libre (Recommended)": sin instrucciones, el agente decide todo.
   - "Memecoins de pump.fun": instrucciones = "Dedica parte del tiempo a investigar memecoins de pump.fun y apuesta por las que veas con más opciones."
   - Con "Other" el usuario puede escribir sus propias instrucciones: pásalas tal cual, sin reescribirlas.
2. **Dónde empieza el dinero** (header "Reparto"). Explica en la pregunta que en cada cadena una parte llega en su token nativo para pagar la red:
   - "Repartido": Solana 30 %, Base 25 %, BNB Chain 25 %, Binance 20 % (`{"solana":30,"base":25,"bsc":25,"binance":20}`).
   - "Todo en Solana" (`{"solana":100}`).
   - "Solo cadenas, sin Binance": Solana 40 %, Base 30 %, BNB Chain 30 % (`{"solana":40,"base":30,"bsc":30}`).
   - Con "Other" el usuario puede dar su propio reparto ("mitad Base, mitad Solana"): conviértelo a porcentajes que sumen 100.
   Marca como recomendada "Repartido" si el capital es de 100 $ o más, y "Todo en Solana" si es menor: repartido quedarían saldos de pocos dólares por sitio, y Binance exige unos 5 $ por orden.

Crea la misión con `create_mission` (`capital_usd`, `target_usd` en valor absoluto, `duration_minutes`, `allocation` con el reparto elegido e `instructions` si las hay; en modo libre no lo envíes).

### 3B. Misión real

1. Llama a `wallet_status`.
   - Si no hay cartera, o el firmante está apagado, bloqueado o parado: llama a `start_wallet` (abre la página de la cartera en su navegador) y explícale que allí debe crearla o desbloquearla con su contraseña. **Nunca pidas ni aceptes en el chat la frase de recuperación ni la contraseña.** Pregunta con AskUserQuestion si ya está ("Ya está desbloqueada" / "Cancelar") y vuelve a llamar a `wallet_status`.
   - Si la cartera vale menos de 5 $, dile que le envíe fondos a las direcciones que aparecen (USDC o USDT, y un poco de SOL, ETH o BNB para el gas) y para aquí.
2. Enseña el saldo real total y por cadena. Después, una llamada a AskUserQuestion con cuatro preguntas:
   1. **Objetivo** (header "Objetivo"), como ganancia sobre lo que vale la cartera: +5 %, +10 % (Recommended), +25 %.
   2. **Tiempo** (header "Tiempo"): 15 minutos, 1 hora (Recommended), 6 horas. Una misión real es siempre normal (la opera el trader), también la de 15 minutos.
   3. **Aprobación** (header "Aprobación"):
      - "Yo apruebo cada operación (Recommended)": el agente propone y la operación espera (hasta 90 s) a que la apruebes en la página de la cartera.
      - "Autónomo con límites": opera solo, dentro de los límites.
   4. **Límites** (header "Límites"):
      - "Prudentes (Recommended)": máximo por operación = 25 % del saldo; pérdida máxima = 30 %.
      - "Amplios": máximo por operación = 50 % del saldo; pérdida máxima = 60 %.
      - Con "Other", el usuario da sus cifras.
3. Pregunta también el **Panel** y el **Enfoque**, como en 3A (pueden ir en la misma llamada a AskUserQuestion que las anteriores si caben; si no, en otra).
4. Crea la misión con `create_mission`: `mode: "live"`, `target_pct`, `duration_minutes`, `approval` (`manual` o `auto`), `max_trade_usd` (en USD, calculado sobre el saldo), `max_loss_pct` e `instructions` si las hay.
5. Si la aprobación es manual, recuérdale que tenga abierta la página de la cartera (desbloqueada) para aprobar las operaciones.

## 4. Panel

Solo si el usuario ha dicho que sí:
Llama a `start_dashboard` con `open_in_system_browser: true`: el panel se abre en el navegador normal del usuario. No lo abras en el navegador integrado de la app: el agente usa ese navegador para investigar y taparía el panel.

Si falla, díselo al usuario con el motivo y sigue: el agente puede trabajar sin panel.

## 5. Lanzar los agentes

Para todas las llamadas a Agent:
- Los prompts van exactamente como se indican. No añadas nada más: ni ideas, ni estrategias, ni contexto de esta conversación. Todo lo que necesitan está en su propia configuración y en el simulador.
- No pases `model` en ninguna llamada a Agent: cada agente trae su modelo y su esfuerzo en su configuración, y pasarlo los pisaría.

### 5R. Misión rápida (15 minutos o menos)

1. **Plan.** Llama a `get_plan` sin parámetros: devuelve el plan de la clase de la misión activa. Si responde que no hay plan vigente, si su `block` dice que ya ha jugado sus 20 misiones, o si trae `withoutCandidate` con `lastMissionWithoutCandidate` (la última misión preparada con él se canceló sin que llegara ningún candidato), lanza el cerebro en primer plano y espera a que termine: `subagent_type` `dementeking:planner`, `description` `Preparar el plan`, `prompt` exactamente `Prepara el plan.` Piensa en esfuerzo máximo y puede tardar 15-30 min; el reloj de la misión no corre mientras tanto. Si hay un plan vigente con el bloque sin terminar y sin ese aviso, no lo lances: el plan queda fijo durante sus 20 misiones (si su última misión se quedó sin candidato, el cerebro decide si lo sustituye).
   Si después del cerebro `get_plan` sigue sin plan, cuéntaselo al usuario con lo que respondió el cerebro, para la misión con `stop_mission` (`close_positions: false`) y para aquí.
2. **Misión viva.** Llama a `mission_status`. Si la misión ya no está activa (se cancela sola si el reloj no arranca en 60 min desde que se creó), créala otra vez con los mismos parámetros y sigue.
3. **Aviso.** Dile al usuario en dos líneas qué va a pasar: el ejecutor espera un token recién graduado que pase los filtros del plan; el reloj arranca con la compra, que va con todo y con la venta puesta en el objetivo; y dónde está el panel, si se abrió.
4. **Ejecutor** (en primer plano, espera a que termine): `subagent_type` `dementeking:executor`, `description` `Misión rápida`, `prompt` exactamente `Ejecuta el plan vigente.`
5. Sin vigía: en una misión de 15 minutos o menos no se lanza el revisor con `Vigila la misión.`, porque no llegaría a revisar nada a mitad. Sigue en el paso 7R.

### 5N. Misión normal

Con la herramienta Agent, en este orden:

1. **Preparación** (en primer plano, espera a que termine): `subagent_type` `dementeking:reviewer`, `description` `Preparar la misión`, `prompt` exactamente `Prepara la misión.` El revisor repasa las misiones anteriores y escribe un briefing para esta. Si falla, díselo al usuario en una línea y sigue: el trader puede trabajar sin briefing.
2. **Trader** (en segundo plano): `subagent_type` `dementeking:trader`, `description` `Misión de trading`, `run_in_background` `true`, `prompt` exactamente `Trabaja en tu misión.`
3. **Revisor durante la misión** (en segundo plano), solo si la misión dura más de 15 minutos (una real de 15 min no lo lleva): `subagent_type` `dementeking:reviewer`, `description` `Revisor de la misión`, `run_in_background` `true`, `prompt` exactamente `Vigila la misión.`

## 6. Avisar al usuario (misión normal)

Resume en pocas líneas: si es una misión REAL (y su aprobación y límites), capital, objetivo y plazo (el reloj arranca cuando el trader empieza a trabajar), el reparto, las instrucciones si las hay, dónde está el panel si se abrió, y que el agente ya trabaja en segundo plano con un revisor que analiza lo que hace y le prepara lo aprendido. La misión termina sola al alcanzar el objetivo o al acabarse el tiempo. Añade que puede escribir `/dementeking:estado` en cualquier momento para ver cómo va, también desde el móvil con Remote Control.

## 7R. Al terminar el ejecutor (misión rápida)

Llama a `status_report` y a `mission_status` (que dice por qué terminó, `endReason`):
- Si la misión sigue activa y el reloj no ha arrancado (el ejecutor terminó sin candidato), díselo al usuario y ofrécele relanzar el ejecutor con el mismo prompt o detener la misión.
- Si se canceló sin arrancar el reloj (`endReason` `prep_timeout`: en 60 minutos no llegó ningún candidato que pasara el plan), díselo en una línea, sin notificación ni revisor (no hay nada que revisar), y ofrécele otra igual con AskUserQuestion ("Otra igual" / "No, por ahora"). Si dice que sí, crea la misión con los mismos parámetros (paso 3R.4) y vuelve al paso 5R: `get_plan` avisará de la misión sin candidato y el cerebro revisará el plan.
- Si sigue activa con el reloj en marcha (el ejecutor se detuvo antes de tiempo), relánzalo una vez con el mismo prompt sin preguntar: retoma la misión donde estaba. Si vuelve a pasar, pregúntale al usuario.
- Si ha terminado con el reloj en marcha (conseguida, por tiempo o sin fondos), resume el resultado y envía una notificación con PushNotification (`status: "proactive"`), en una línea de menos de 200 caracteres y sin formato, empezando por el resultado. Por ejemplo: "Misión #7 conseguida: 50 $ → 62,60 $ (+25,2 %) en 6 min". Si la herramienta no existe o no se envía, no pasa nada: el resumen ya está en el chat. Después:
  1. **Revisor** (en segundo plano): `subagent_type` `dementeking:reviewer`, `description` `Revisar la misión`, `run_in_background` `true`, `prompt` exactamente `Revisa la misión.`
  2. Ofrécele otra misión igual con AskUserQuestion ("Otra igual" / "No, por ahora"): el plan de su clase sigue vigente hasta completar sus 20 misiones, y con pocas misiones no se sabe nada. Si dice que sí, crea la misión con los mismos parámetros (paso 3R.4) y vuelve al paso 5R, sin repetir las preguntas.
- Cuando termine el revisor, pásale al usuario su resumen en dos o tres líneas (la P realista y cómo va la clase frente al gemelo mecánico). Si en ese momento hay otra misión en marcha, espera a que termine para contárselo.

## 7N. Mientras dura la misión (misión normal)

Cuando termine un **revisor** en segundo plano:
- Si su respuesta empieza por "Misión terminada:", no lo relances.
- Si no, y la misión sigue activa (compruébalo con `mission_status`), vuelve a lanzarlo igual que en el paso 5N.3. No se lo cuentes al usuario más allá de una línea breve: es rutina.

Cuando termine el **trader**, llama a `status_report`:
- Si la misión sigue activa (el agente se detuvo antes de tiempo), díselo al usuario y ofrécele relanzarlo con el mismo prompt.
- Si ha terminado, resume el resultado y envía una notificación con PushNotification (`status: "proactive"`), en una línea de menos de 200 caracteres y sin formato, empezando por el resultado. Por ejemplo: "Misión #4 conseguida: 100 $ → 111,20 $ (+11,2 %) en 38 min". Si la herramienta no existe o no se envía, no pasa nada: el resumen ya está en el chat. El revisor hará la retrospectiva de la misión; si no hay ninguno trabajando en segundo plano, lánzalo como en el paso 5N.3.
