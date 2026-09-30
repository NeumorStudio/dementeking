# dementeking

Copia de [cryptoagent](https://github.com/NeumorStudio/cryptoagent) (de Carlos) con otro nombre, para que cada uno
tenga su agente y lo edite por separado. Parte de la v0.36.2 con todo su historial: las mejoras de cryptoagent se pueden
traer con `git fetch carlos && git merge carlos/main` (remoto `carlos` = `NeumorStudio/cryptoagent`). Puede instalarse a
la vez que cryptoagent sin que se pisen: comandos `/dementeking:*`, datos en `~/.dementeking` y panel en el puerto 4331.

Plugin de Claude Code: un agente autónomo que opera criptomonedas **en simulación**.
El dinero es ficticio, pero los precios, la liquidez y las comisiones son reales y del momento:
Solana a través de Jupiter (incluidos los tokens de pump.fun), Base y BNB Chain con un monedero tipo MetaMask (KyberSwap y ParaSwap) y Binance spot. Nunca se firma ni se envía nada real.

- **Misiones**: capital inicial, objetivo y plazo real. La misión termina sola al alcanzar el objetivo
  o al acabarse el tiempo, y entonces se venden todas las posiciones a mercado.
- **Misiones rápidas** (5-15 min, simuladas): un cerebro escribe antes del reloj un plan de reglas y otro agente lo
  ejecuta: una sola compra con todo en un memecoin recién graduado, con la venta puesta en el objetivo. Se comparan
  con una línea base medida y con un gemelo mecánico para saber si el agente aporta algo ([más abajo](#misiones-rápidas)).
- **Agente libre**: decide qué investigar y qué hacer. Opcionalmente le das instrucciones por misión.
- **Memoria entre misiones, escrita por un revisor**: un segundo agente analiza lo que hace el que opera y escribe su memoria.
  Tiene tres partes: howtos (cómo se hace algo y qué errores evitar), creencias sobre el mercado cuya evidencia calcula el
  simulador con las operaciones reales, y la retrospectiva de cada misión. Antes de cada misión, el revisor le prepara un briefing;
  en misiones largas, revisa también a mitad y le avisa si hay algo importante.
- **Multicadena**: Solana, Base y BNB Chain (con un monedero tipo MetaMask) y Binance, con depósitos, retiradas y puentes
  entre ellos que tardan lo que tardarían de verdad. También puede estimar lo que costaría lanzar su propio token.
- **Peticiones**: si el agente necesita algo que no tiene (una cuenta en una red social, otro exchange, una herramienta…),
  lo anota y tú decides si se lo das.
- **Panel en directo** (localhost): progreso, gráfico, posiciones, órdenes, memoria y una transcripción
  de lo que hace el agente.

## Instalar

Necesitas **Node.js 22.13 o superior** (usa el SQLite integrado en Node).

Funciona solo en **Claude Code**: la pestaña **Code** de la app de escritorio, la terminal o las extensiones
de VS Code y JetBrains. En el chat normal de Claude las habilidades se cargan, pero el simulador y el agente no pueden arrancar.

En Claude Code:

```
/plugin marketplace add NeumorStudio/dementeking
/plugin install dementeking@dementeking
```

En la app de escritorio: **Ajustes → Plugins → Añadir marketplace** con `NeumorStudio/dementeking`, e instala
el plugin desde **Descubrir**. Después abre una sesión nueva.

Este repositorio es a la vez el código fuente y el marketplace (`.claude-plugin/marketplace.json` apunta a `./plugin`).

## Usar

- `/dementeking:trading`: te pregunta primero si la misión es rápida (5-15 min) o normal, y después capital, objetivo,
  tiempo y si abrir el panel; crea la misión y lanza los agentes. Si ya hay una misión activa, te deja continuarla,
  reemplazarla o detenerla.
- `/dementeking:estado`: resumen de la misión en el chat (progreso, posiciones, últimos movimientos con su motivo
  y la última nota del agente). Pensado también para consultarlo desde el móvil con Remote Control.
- `/dementeking:parar`: detiene la misión activa (cerrando posiciones o no).
- `/dementeking:peticiones`: lo que el agente ha pedido y no tiene; puedes aceptarlo, rechazarlo o marcarlo como hecho.

Al terminar una misión, Claude te avisa con una notificación; con Remote Control conectado, también en el móvil.

No inicies sesión en exchanges ni redes sociales dentro del navegador de la app: el agente lo usa.

Los datos (misiones, diario, lecciones) se guardan en `~/.dementeking`, fuera del plugin: se conservan al
actualizar o reinstalar, y son los mismos se instale desde la app o desde la CLI.

## Misiones rápidas

Una misión de 15 minutos o menos no da tiempo a pensar dentro del reloj: cada minuto de retraso al entrar resta 3-4
puntos de probabilidad. Por eso, si es simulada, se reparte entre dos agentes (una real siempre la opera el trader, aunque
sea corta):

1. **El cerebro** (`planner`) piensa antes de que arranque el reloj, que es tiempo gratis. Escribe un plan de **reglas**, no
   una lista de tokens: qué evento esperar (por defecto, un token de pump.fun recién migrado a PumpSwap), qué filtros tiene
   que pasar, la toma de beneficio, si hay reentrada y qué probabilidad espera frente a la línea base. El plan queda fijo
   durante un bloque de 20 misiones de la misma clase (mercado × plazo × objetivo, p. ej. `graduado-10m-+25%`): si cambiara
   en cada misión, no se mediría nada.
2. **El ejecutor** (`executor`) espera el evento sin arrancar el reloj y, en cuanto llega un candidato, arranca el reloj,
   compra con todo y deja puesta la venta en el objetivo en una sola llamada. Todo lo que puede fallar sin operar (el plan,
   el efectivo, el token, un pool vaciado, la memoria) se comprueba antes de arrancar el reloj: si falla, sigue parado. Después solo espera: sin rotar, promediar,
   poner stops ni investigar. Es la "jugada audaz": en un juego desfavorable, la forma de maximizar la probabilidad de
   llegar a una meta es apostar fuerte y pocas veces.
3. **El revisor** (`reviewer`) revisa cada misión al terminar: la compara con su gemelo mecánico (la misma compra con la
   misma venta en los 3 eventos siguientes) y lleva la cuenta por clase, con su intervalo de confianza.

El reloj arranca con la entrada, no al crear la misión; si no arranca en 60 minutos, la misión se cancela sola. Mientras
dura, órdenes, futuros y misión se miran cada 5 s, y no hay revisor a mitad.

**Qué esperar.** Probabilidad medida de llegar al objetivo con un recién graduado (datos reales de un solo día, 925 tokens):

| Plazo | +25 % | +50 % | ×2 |
|---|---|---|---|
| 5 min | 24 % | 11 % | 5 % |
| 10 min | 35 % | 21 % | 9 % |
| 15 min | 37 % | 25 % | 14 % |

Ninguna configuración rápida gana dinero de media: con costes reales se pierde entre un 7 y un 28 % por misión, y el
simulador es algo optimista (sin latencia ni MEV, la venta límite se llena justo a su precio). La misión por defecto es
50 $, +25 %, 10 minutos y todo en Solana. Con menos de 20 misiones por clase no se puede saber si el agente aporta algo:
0 aciertos de 20 son compatibles con una tasa real de hasta el 16 %. Detalle en la sección 7 de la
[guía del terreno](knowledge/guia-del-terreno.md).

**Costes realistas (opcional).** Con `costs: "real"` en `create_mission`, los swaps de Solana de la misión (y los de su
gemelo) pagan lo que pagaría una cartera de verdad: fee con prioridad de 0,00075 SOL por transacción (en vez de 0,0001),
la renta de la cuenta de cada token nuevo (0,00203928 SOL) sin devolver al venderlo, y 2 s de latencia entre cotizar y
ejecutar (`LATENCY_MS`): el swap se llena a la cotización de después y revierte si ha empeorado más que su slippage, y la
toma de beneficio solo se llena si esa cotización sigue llegando al límite. Esas misiones son otra serie: las
estadísticas por clase, el historial y las retrospectivas las separan de las de costes de siempre.

La toma de beneficio en el objetivo cuenta el SOL que queda como estará al cerrar la misión (menos la red de la venta y
la de convertirlo, y con su precio un 0,5 % más bajo): si salta, la misión queda conseguida. El cierre por objetivo mide
igual lo que quedaría al cerrar (no la valoración en bruto), así que no se adelanta a esa orden, y su venta a mercado
tiene un mínimo: si tras la latencia ya no llega, no se vende y la toma de beneficio sigue puesta. Una misión solo queda
conseguida si lo que queda al final llega al objetivo: en la misión por defecto, si el SOL baja más de un ~4 % (~7 % con
costes realistas) entre poner la toma de beneficio y que salte, se llena pero no llega. `mission_status` y la
retrospectiva dicen además cuánto tardó en prepararse (de pedirla a arrancar el reloj) y en entrar desde la señal.

### Qué modelo usa cada agente

| Agente | Papel | Modelo | Esfuerzo | Cuándo corre |
|---|---|---|---|---|
| `planner` | Cerebro de las rápidas: el plan de reglas | `claude-opus-5-5` | `max` | Antes del reloj, una vez por bloque de 20 misiones |
| `executor` | Ejecuta las rápidas | `claude-sonnet-5-5` | `medium` | Dentro del reloj (~17 s por decisión) |
| `trader` | Opera las normales (1 hora a 3 días) | `claude-sonnet-5-5` | `xhigh` | Dentro del reloj, sin prisa |
| `reviewer` | Memoria, retrospectivas y línea base | `claude-opus-5-5` | `xhigh` | Antes y durante las normales; después de cada rápida |

El modelo y el esfuerzo van en la cabecera de cada agente (`plugin/agents/*.md`), con el identificador completo. La skill
no pasa `model` al lanzarlos, porque lo pisaría. Tampoco definas `CLAUDE_CODE_EFFORT_LEVEL`: pisa el esfuerzo de la cabecera.

### Sin interfaz (headless)

Primero hay que crear la misión (con `/dementeking:trading` o con la herramienta `create_mission` del servidor MCP).
Después, cada agente con su prompt exacto:

```bash
claude -p "Prepara el plan." --agent dementeking:planner --allowedTools "mcp__plugin_dementeking_cryptosim,ToolSearch"
claude -p "Ejecuta el plan vigente." --agent dementeking:executor --allowedTools "mcp__plugin_dementeking_cryptosim,ToolSearch"
claude -p "Revisa la misión." --agent dementeking:reviewer --allowedTools "mcp__plugin_dementeking_cryptosim,ToolSearch"
```

- El cerebro solo hace falta si la clase no tiene un plan vigente (o si el suyo ya ha jugado sus 20 misiones).
- Para una misión normal, el revisor usa `"Prepara la misión."` antes y `"Vigila la misión."` durante, y el trader,
  `"Trabaja en tu misión."` con `--agent dementeking:trader`.
- Para probar el repositorio sin instalar el plugin, añade `--plugin-dir ./plugin`.
- **Versión del CLI.** Con el CLI 2.1.272, los alias caen en la generación anterior y `claude-sonnet-5-5` da
  `unrecognized_model`: los agentes no usarían los modelos 5.5. Actualiza el CLI o usa el `claude.exe` de la app de
  escritorio, que sí los reconoce (en Windows, `%APPDATA%\Claude\claude-code\<versión>\claude.exe`, 2.1.284 o
  posterior). Con `--output-format json` puedes comprobar en `modelUsage` qué modelo ha corrido de verdad.

## Usar en OpenCode

También funciona en [OpenCode](https://opencode.ai) (escritorio o terminal), con el modelo que tengas seleccionado allí.
Desde este repositorio:

```bash
npm install
npm run install:opencode
```

Copia el simulador a `~/.dementeking/opencode`, añade el servidor MCP `cryptosim` a `~/.config/opencode/opencode.json`
(sin tocar el resto), y genera los agentes `trader` y `reviewer` (a partir de los mismos prompts) y los comandos:
`/dementeking-trading` (p. ej. `/dementeking-trading 20 40 5`), `/dementeking-estado`, `/dementeking-parar`,
`/dementeking-peticiones` y `/dementeking-panel`. Después, reinicia OpenCode.

OpenCode tiene su propia base de datos (`~/.dementeking/opencode-data`) y su propio panel (http://localhost:4332):
sus misiones y su memoria no se mezclan con las de Claude Code, así que puedes comparar cómo aprende con cada modelo.
Otras diferencias: en OpenCode los agentes
van uno detrás de otro (el revisor prepara, el trader trabaja y el revisor hace la retrospectiva al final, sin revisar a
mitad), no hay navegador ni aviso al terminar, y el panel no muestra la transcripción del agente (sí todo lo demás).
Tras actualizar el código, vuelve a ejecutar `npm run install:opencode`.

## Actualizaciones

En marketplaces que no son de Anthropic la actualización automática viene desactivada. Para actualizar:

```
/plugin marketplace update dementeking
/plugin update dementeking@dementeking
```

O activa la actualización automática de este marketplace en el gestor de plugins.

## Dinero real

El agente también puede operar con dinero de verdad, desde una cartera **nueva** que es solo suya, en Solana, Base y BNB Chain.

**Es dinero real y los memecoins pueden irse a cero en minutos.** Mete solo lo que estés dispuesto a perder entero y empieza con poco (20–50 $) y con aprobación manual.

### Cómo empezar

1. **Crea la cartera.** Escribe `/dementeking:cartera` (en OpenCode, `/dementeking-cartera`). Se abre en tu navegador la página de la cartera. Ahí eliges una contraseña y ves **una sola vez** la frase de recuperación: apúntala en papel. Puedes importarla en MetaMask (Base y BNB Chain) y en Phantom (Solana) para ver la cartera.
2. **Dale fondos.** Envía USDC o USDT a las direcciones de la página, y un poco de SOL, ETH o BNB para pagar la red.
3. **Lanza una misión real.** `/dementeking:trading` pregunta primero el modo; elige **Real** y decide:
   - **aprobación**: apruebas cada operación en la página de la cartera (espera hasta 90 s), o autónomo;
   - **límites**: máximo por operación y pérdida máxima.
4. **Sigue la misión.** El panel muestra una banda "DINERO REAL", las aprobaciones pendientes y un enlace al explorador en cada operación.

### Qué puede hacer el agente

- Swaps con `execute_swap`: Jupiter en Solana y KyberSwap en Base y BNB Chain.
- Mover estables o el nativo entre sus cadenas con `execute_bridge` (Li.Fi).
- **No** puede enviar fondos a otra dirección: no existe ninguna herramienta para hacerlo.

### Cuándo se para

- Como mucho hace 6 operaciones por minuto (60 por hora).
- Si la cartera baja de la pérdida máxima, la misión **se para sola**: vende los tokens a estables y termina.
- Al terminar (por objetivo, por plazo o por pérdida), vende los tokens a estables y deja el nativo para el gas.
- El botón **Parar todo** de la página de la cartera rechaza al instante todo lo pendiente y bloquea la firma hasta que vuelvas a desbloquearla.

### Cómo se protege la clave

- **El modelo nunca la ve.** La frase y la clave no pasan por el chat, la base de datos ni el panel. Firma un proceso aparte, el *firmante*, que escucha solo en `127.0.0.1`.
- **Se guarda cifrada.** La frase está en `~/.dementeking/live/wallet.enc`, cifrada con tu contraseña (scrypt + AES-256-GCM). El firmante se desbloquea con esa contraseña en su página. Si se reinicia el ordenador, hay que volver a desbloquearla.
- **El firmante revisa cada transacción antes de firmar:**
  - **Swaps:** solo van a Jupiter o al router de KyberSwap, y lo comprado vuelve a la propia cartera.
  - **Puentes:** solo van al contrato de Li.Fi, y el destino que devuelve Li.Fi debe ser la propia cartera.
  - **Nunca sale más de lo aprobado.** En Base y BNB Chain, los approves son por la cantidad exacta y hay un tope de nativo por transacción. En Solana, el firmante simula cada transacción y comprueba que ningún saldo de la cartera baje más de lo aprobado.
  - **Límites de la misión:** máximo por operación, pérdida máxima y ritmo.

### Impuestos

`/dementeking:impuestos` (en OpenCode, `/dementeking-impuestos`) exporta a CSV, para Excel, dos archivos:
- **Operaciones reales:** todas, con hash, cantidades, valor en USD y EUR y comisión de red.
- **Resultados por posición.**

Es un registro de apoyo, no asesoramiento fiscal. En España cada permuta entre criptomonedas es una ganancia o pérdida patrimonial y Hacienda exige FIFO; aquí el coste de cada posición es el medio.

### Opcional

- `SOLANA_RPC_URL`: una RPC de Solana propia (por ejemplo, con una clave gratuita de Helius). La pública a veces falla al enviar transacciones.
- `LIFI_API_KEY`: más cupo en Li.Fi (sin clave son 75 consultas cada 2 horas).

## Qué se simula y cómo

| Acción | Cálculo |
|---|---|
| Swap en Solana | Cotización real de Jupiter + fee de red en SOL + renta de la cuenta del token |
| Swap en Base o BNB Chain | Cotización real de KyberSwap (o ParaSwap) + gas real en ETH o BNB + approve la primera vez que se vende un token + impuestos del token (GoPlus): si superan el slippage, revierte y se pierde el gas |
| Orden de mercado en Binance | Se recorre el order book real + comisión taker + tamaño mínimo |
| Depósito o retirada de Binance | Por la red de cada cadena: gas al depositar, comisión y mínimo reales de Binance al retirar; llega en 1-3 min |
| Puente entre cadenas | Cotización real de Li.Fi (coste, gas y duración); si se agota su cupo gratuito, una estimación |
| Orden condicional | Se dispara cuando el precio de venta real cruza el umbral (comprobado cada 15 s; cada 5 s en una misión rápida) |
| Futuros perpetuos | Precio y funding reales de Hyperliquid, con su comisión, depósito, retirada y liquidación; solo en simulación |
| Valoración | Precio de liquidación: cuánto se obtendría vendiéndolo todo ahora |
| Acciones hipotéticas | Solo se anotan (crear tokens, publicar…); no afectan a la cartera |

No se simulan MEV, latencia ni el impacto de tus operaciones en los demás.
El agente tiene una guía con estos detalles y las APIs de datos disponibles: [knowledge/guia-del-terreno.md](knowledge/guia-del-terreno.md).

## Estructura del repositorio

```
plugin/                           el plugin que se instala
  .claude-plugin/plugin.json      manifiesto y versión
  .mcp.json                       servidor MCP del simulador
  agents/trader.md                el agente que opera las misiones normales
  agents/planner.md               el cerebro de las misiones rápidas: escribe el plan de reglas
  agents/executor.md              el que ejecuta las misiones rápidas
  agents/reviewer.md              el revisor: escribe la memoria, prepara y revisa cada misión
  skills/                         los comandos (trading, estado, parar, peticiones)
  dist/                           servidor MCP empaquetado (generado, se sube al repo)
src/                              código fuente del simulador, el panel y el runner por API
knowledge/                        guía del terreno
```

## Desarrollo

```bash
npm install
npm run build:plugin      # regenera plugin/dist a partir de src/
npm run typecheck
npm test                  # tests (cada archivo usa una base de datos temporal)
npx tsx scripts/migrate-dry.ts   # prueba las migraciones sobre una copia de ~/.dementeking/sim.db
npx tsx scripts/smoke.ts         # recorrido contra las APIs reales en una base de datos temporal
```

Los cambios de esquema van en `src/migrations.ts`, como un paso nuevo al final de la lista. Antes de migrar una
base de datos con datos se guarda una copia en `~/.dementeking/backups`.

Los prompts de los agentes están solo en `plugin/agents/`. El runner por API los lee de ahí y quita las líneas
marcadas con `<!-- solo-plugin -->`.

Para probar tus cambios, añade este repositorio como marketplace local (`/plugin marketplace add ./`) e instala el
plugin. Tras cada cambio: `npm run build:plugin` y `/plugin update dementeking@dementeking`.

**Publicar una versión**: sube `version` en `plugin/.claude-plugin/plugin.json` y ejecuta `npm run build:plugin`,
que sincroniza la versión en `.claude-plugin/marketplace.json`. Haz commit y push.
Los usuarios reciben la versión nueva al actualizar; mientras no cambies `version`, no ven los cambios.

### Runner por API (opcional, sin Claude Code)

El mismo agente puede ejecutarse con la API de Anthropic y un navegador propio (Playwright):

```bash
npx playwright install chromium
cp .env.example .env      # pon tu ANTHROPIC_API_KEY
npm run mission -- --capital 1000 --target 1050 --hours 24
npm run agent             # trabaja hasta que termine la misión
npm run dashboard         # panel en http://localhost:4331
npm run watcher           # vigila órdenes y misión sin agente
npm run report
```
