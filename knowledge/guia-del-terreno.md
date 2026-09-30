# Guía del terreno

Información factual sobre el entorno: qué puedes ejecutar, cómo se simula, cómo funcionan las
plataformas y qué fuentes de datos públicas responden. No son recomendaciones de estrategia.
Datos verificados el 27 y el 28 de septiembre de 2026; las plataformas cambian, así que contrasta lo que dependa de cifras concretas.

## 1. Qué puede ejecutar el simulador

| Mercado | Cómo | Herramienta |
|---|---|---|
| Cualquier token de Solana con ruta en Jupiter | Swap al precio de cotización de Jupiter en ese instante | `simulate_swap` (chain: solana) |
| Tokens de pump.fun **en la curva** (sin graduar) | Jupiter los enruta por el programa de pump.fun (ruta "Pump.fun") | `simulate_swap` (chain: solana) |
| Tokens de pump.fun **graduados** | Jupiter los enruta por PumpSwap (ruta "Pump.fun Amm") | `simulate_swap` (chain: solana) |
| Cualquier token de **Base** con ruta en KyberSwap (o ParaSwap) | Swap al precio de cotización del agregador en ese instante | `simulate_swap` (chain: base) |
| Cualquier token de **BNB Chain** con ruta en KyberSwap (o ParaSwap) | Igual que en Base | `simulate_swap` (chain: bsc) |
| Binance spot | Orden de mercado contra el order book real | `simulate_binance_market_order` |
| Órdenes condicionales | Por precio (se disparan con el precio de venta real, comprobado cada 15 s; cada 5 s en una misión rápida) o por tiempo (se ejecutan a los minutos que indiques, pase lo que pase) | `place_*_trigger_order` |
| Futuros perpetuos, largos o cortos, con apalancamiento | Precio y funding reales de Hyperliquid (sección 6); el margen sale del efectivo de una cadena | `open_perp`, `close_perp`, `set_perp_exits` |
| Entrada de una misión rápida | Compra con todo el efectivo de la cadena y deja puesta la toma de beneficio en una llamada; si el reloj no ha arrancado, lo arranca, pero solo si antes pasa todas las comprobaciones (plan, efectivo, token, una ida y vuelta de más del 10 %, memoria): si falla, el reloj sigue parado (sección 7) | `enter_with_exits` |

**No ejecutable** (solo se puede anotar con `record_hypothetical_action`): crear tokens, publicar en redes,
otras blockchains (Ethereum, Arbitrum…), préstamos, staking, airdrops. Los futuros sí se ejecutan, pero solo en simulación. Si necesitas algo que no
tienes para intentarlo, pídelo con `request_capability`.

**Lanzar un token propio**: `estimate_token_launch` calcula lo que costaría con el gas y los precios de ahora
(en Solana con pump.fun; en Base y BNB Chain, desplegando un ERC-20 y creando su pool). El lanzamiento en sí
no se simula, porque su mercado depende de otras personas: si decides hacerlo, anótalo con
`record_hypothetical_action` junto con la estimación.

**Límites de las fuentes**: las APIs gratuitas tienen límites de peticiones. El simulador reparte el ritmo
(Jupiter, KyberSwap, GoPlus) y el cupo de Li.Fi (75 cada 2 horas; si se agota, los puentes usan una
estimación). Si una fuente devuelve 429, espera o usa otra.

Para saber si un token concreto es operable, pide una cotización con `quote_swap` en su cadena: si no hay ruta, no se puede.

Tus monederos: uno en Solana y uno tipo MetaMask (la misma dirección en Base y en BNB Chain, cada cadena con
sus propios saldos), más tu cuenta de Binance. El reparto inicial del capital lo elige el usuario en cada misión.
Mover dinero entre sitios (el dinero sale al momento y llega después; mientras tanto aparece "en tránsito"):
- **Binance ↔ tus monederos** (`simulate_transfer`), por la red de cada cadena: USDC por Solana, Base o BNB Chain;
  USDT por Solana o BNB Chain; SOL por Solana; ETH por Base; BNB por BNB Chain. Al depositar pagas la red de la
  cadena; al retirar, la comisión de retirada de Binance, con un mínimo (p. ej. USDC: 0,3 por Solana, 0,2 por
  Base, 0 por BNB Chain; mínimo 3). Llega en 1-3 minutos.
- **Entre cadenas** (`simulate_bridge`), con Li.Fi, que elige el puente: pagas el gas en la cadena de origen y la
  comisión del puente va descontada de lo que recibes (suele ser de céntimos). Puedes cambiar de token por el
  camino. Llega en segundos o minutos. `quote_bridge` da una estimación sin gastar nada.

**Misiones reales** (`mission_status` dice `mode: REAL`): la cartera es la de verdad de la IA, en Solana, Base y
BNB Chain.
- **Swaps:** con `execute_swap`, Jupiter en Solana y KyberSwap en Base y BNB Chain.
- **Puentes entre las propias cadenas:** con `execute_bridge` (Li.Fi), solo con estables o el nativo.
  - La llegada la confirma Li.Fi; mientras tanto el dinero aparece "en tránsito".
  - Si un puente falla, normalmente el dinero vuelve a la cadena de origen.
- **Binance y `simulate_transfer`:** no están disponibles.
- Cada transacción paga la red real, también si revierte. El slippage se aplica en la cadena.
- En Base y BNB Chain, la primera venta de un token necesita un approve, que es otra transacción con su gas.
- Siempre se reserva algo del nativo para el gas: 0,01 SOL, 0,0003 ETH o 0,002 BNB.
- El firmante (un proceso aparte que tiene la clave) valida cada transacción y aplica los límites de la misión. En
  aprobación manual, espera hasta ~90 s a que el usuario la apruebe.
- Al terminar, los tokens se venden a estables y el nativo se queda.

## 2. Cómo se simula (y qué no se simula)

- El precio de ejecución es la cotización de Jupiter o el order book de Binance **en el momento de la llamada**.
- **Slippage**: como al firmar en un monedero, protege la cotización que viste. Si cotizas un swap con `quote_swap` y lo
  ejecutas con el mismo importe en menos de 60 s, y el precio se ha movido más que tu `slippage_bps`, el swap revierte y
  solo pagas la red. Si ejecutas sin cotizar antes, se ejecuta al precio de ese momento (y el slippage no tiene contra qué medirse).
  Las comisiones de los pools (incluida la de pump.fun) ya van dentro de la cotización.
- Se cobran además: la fee de red de Solana (fija, configurable) y la renta de la cuenta de token
  (0,00203928 SOL al recibir un token nuevo; se recupera al vaciar esa cuenta). Sin SOL no puedes operar en Solana.
- Base y BNB Chain (EVM), como en MetaMask:
  - El gas se paga en el nativo (ETH en Base, BNB en BNB Chain), con el gas estimado por el agregador y el precio
    del gas real; en Base se suma la pequeña fee de L1. Sin nativo no puedes operar en esa cadena
    ("insufficient funds for gas * price + value").
  - La primera vez que vendes un token hay que aprobar al router (approve): es otra transacción con su gas.
  - Impuestos de compra y venta del token (datos de GoPlus): recibes menos de lo cotizado. Si el impuesto supera
    tu slippage, **el swap revierte y pierdes el gas**. Con tokens con impuesto, sube el slippage.
  - Un token marcado como honeypot no se puede vender: el swap revierte (pagas el gas) y en tu cartera vale 0.
  - Si GoPlus no conoce el impuesto de un token, la cotización lo avisa: podría tenerlo.
- Binance: comisión taker 0,1 %, tamaño mínimo por par (unos 5 $) y retirada de USDC o SOL a Solana con comisión.
- Al transferir un token entre Solana y Binance (`simulate_transfer`), su coste viaja con él: el resultado se mide al venderlo en el destino.
- **No se simula**: MEV ni sandwiches, competencia por prioridad, latencia entre decidir y ejecutar,
  ni el impacto de tus operaciones en el precio que ven los demás.
- La cartera se valora a precio de **liquidación**: lo que obtendrías vendiéndolo todo ahora. En tokens con poca
  liquidez ese valor puede quedar muy por debajo del precio "de pantalla".
- Al terminar la misión se vende todo a mercado; en tokens ilíquidos eso también tiene coste.
- Tiempo: cada paso tuyo (decidir, llamar a una herramienta, leer el resultado) también cuenta. Medido en misiones anteriores: 11 s de mediana por paso, 28-57 s cuando se redacta una tesis, y 84-111 s entre `start_session` y la primera operación. Una sola decisión tarda unos 17 s con esfuerzo medio, unos 60 s con esfuerzo alto y 5-7 min con el máximo.
- El reloj de la misión arranca con el primer `start_session` o `enter_with_exits`, no al crearla. Antes se puede preparar y esperar, pero no operar; si no arranca en 60 min desde que se creó, la misión se cancela.

## 3. pump.fun

Fuente principal: documentación oficial (pump.fun/docs/fees, pump.fun/docs/bonding-curve).

- Crear un token cuesta 0 SOL. Cualquiera puede crear uno; se crean del orden de un millón al mes (fuente secundaria).
- **Curva de precios**: AMM de producto constante con reservas virtuales. Cada compra sube el precio y cada venta lo baja;
  el impacto crece con el tamaño de la operación.
- **Comisión en la curva: 1,25 %** por operación (0,30 % creador + 0,95 % protocolo).
- **Graduación**: cuando la capitalización en la curva alcanza el umbral, la curva se cierra y toda la liquidez migra
  automáticamente a PumpSwap (el pool queda en manos del protocolo). Cuesta 0,015 SOL. La documentación oficial no publica
  la cifra; fuentes secundarias hablan de unos 69.000 $ de capitalización (unos 85 SOL en la curva) y de que menos del 2 %
  de los tokens llega a graduarse.
- **PumpSwap** (tras graduar): comisión decreciente con la capitalización, del 1,25 % (0–420 SOL de capitalización) al
  0,30 % (≥ 98.240 SOL). Pools no canónicos: 0,3 %. Datos actualizados por pump.fun el 20 de mayo de 2026.
- Las direcciones (mint) de tokens creados en pump.fun suelen terminar en `pump`.

## 4. Fuentes de datos públicas (sin clave, comprobadas)

Atajos: `scan_market` combina en una llamada, para la cadena que indiques, las fuentes de candidatos (en Solana:
tendencias de Jupiter, pump.fun en directo, promocionados de DexScreener y tendencias de GeckoTerminal; en Base y
BNB Chain: tendencias y pools nuevos de GeckoTerminal y promocionados de DexScreener); `token_report` junta la ficha
de un token (en Solana: Jupiter, DexScreener, RugCheck y pump.fun; en Base y BNB Chain: DexScreener y la seguridad
de GoPlus). Para cualquier otra consulta, usa estas APIs con `http_get`. Todas devuelven JSON.

**Base y BNB Chain**
- Seguridad de un token (honeypot, impuestos, holders): `https://api.gopluslabs.io/api/v1/token_security/<8453 en Base | 56 en BNB Chain>?contract_addresses=<dirección>`
  (una dirección por consulta; los impuestos vienen en tanto por uno, y vacíos si no se conocen).
- Pares y precios: `https://api.dexscreener.com/tokens/v1/<base|bsc>/<dirección>`.
- Tendencias y pools nuevos: `https://api.geckoterminal.com/api/v2/networks/<base|bsc>/trending_pools` y `.../new_pools`.

**pump.fun**
- Tokens más recientes: `https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false`
- En directo ahora: `https://frontend-api-v3.pump.fun/coins/currently-live?limit=50&offset=0&includeNsfw=false`
- Campos útiles: `mint`, `name`, `symbol`, `created_timestamp` (ms), `usd_market_cap`, `ath_market_cap`,
  `complete` (true = graduado), `real_sol_reserves` (lamports en la curva), `reply_count`, `last_trade_timestamp`, `creator`.

**Jupiter** (datos de tokens de Solana)
- Recientes: `https://lite-api.jup.ag/tokens/v2/recent`
- Más tendencia / más negociados: `https://lite-api.jup.ag/tokens/v2/toptrending/5m?limit=50`, `.../toptraded/5m?limit=50`
  (intervalos: 5m, 1h, 6h, 24h)
- Buscar por mint o nombre: `https://lite-api.jup.ag/tokens/v2/search?query=<mint o texto>`
- Precio: `https://lite-api.jup.ag/price/v3?ids=<mint1>,<mint2>`
- Campos útiles: `mcap`, `liquidity`, `holderCount`, `stats5m`/`stats1h` (`buyVolume`, `numBuys`, `numTraders`, `numNetBuyers`),
  `audit` (`mintAuthorityDisabled`, `freezeAuthorityDisabled`, `devBalancePercentage`), `organicScore`, `launchpad`, `createdAt`.

**DexScreener**
- Perfiles recientes: `https://api.dexscreener.com/token-profiles/latest/v1`
- Tokens promocionados (boosts): `https://api.dexscreener.com/token-boosts/latest/v1`, `.../token-boosts/top/v1`
- Pares de un token: `https://api.dexscreener.com/tokens/v1/solana/<mint>` o `https://api.dexscreener.com/latest/dex/tokens/<mint>`
- Búsqueda: `https://api.dexscreener.com/latest/dex/search?q=<texto>`
- Los tokens muy nuevos que siguen en la curva de pump.fun a veces aún no tienen par en DexScreener.

**GeckoTerminal**
- Pools nuevos en Solana: `https://api.geckoterminal.com/api/v2/networks/solana/new_pools`
- Pools en tendencia: `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools`
- Velas: `https://api.geckoterminal.com/api/v2/networks/solana/pools/<pool>/ohlcv/minute?limit=60`
- Campos útiles: `price_change_percentage`, `transactions`, `volume_usd`, `reserve_in_usd`, `pool_created_at`.

**RugCheck** (riesgos de un token de Solana)
- `https://api.rugcheck.xyz/v1/tokens/<mint>/report/summary`: lista de riesgos con nivel (`danger`, `warn`…)
  y puntuación. Ejemplos de riesgos que reporta: historial de rugs del creador, concentración en un solo holder.

**Mercado general**
- Binance: `https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDC`, velas `.../api/v3/klines?symbol=SOLUSDC&interval=1m&limit=60`
- Binance futuros (solo datos): funding `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=SOLUSDT`
- CoinGecko tendencias: `https://api.coingecko.com/api/v3/search/trending`
- Índice Fear & Greed: `https://api.alternative.me/fng/?limit=1`

Webs como DexScreener pueden mostrar controles anti-bot en el navegador; sus APIs sí responden.

## 5. Datos de riesgo de un token (`riskCheck`)

Solo datos, sin veredicto: qué significan para tus resultados lo decides tú con tus misiones y lo apuntan tus creencias.

- **Creador.** `creatorTokens` (tokens que ha lanzado) y `creatorGraduated` (cuántos se graduaron), de Jupiter en Solana; en EVM, GoPlus da el creador, lo que conserva (`devHoldingPct`) y sus otros honeypots (`creatorHoneypots`). `creatorTradesWithYou` y `creatorWorstPnlWithYouPct`: cuántos tokens suyos has operado tú y el peor resultado que te dieron.
- **Token.** `insidersDetected` y `lpLockedPct` (RugCheck), `honeypot` e impuestos (GoPlus), `mcapToLiquidity` y `launchpad`. En BNB Chain el launchpad sale de la dirección: …7777 = Flap.sh, …4444 o …ffff = four.meme, también en tus operaciones antiguas.
- **Volumen según cada fuente.** `token_report` trae `volumeCheck`: el volumen de 1 h según Jupiter, el de todos los pares de DexScreener y su cociente (`volume1hJupiterVsDexRatio`, también en los datos de cada posición).
- **Entre lecturas.** Si lees un token dos veces, `riskCheck.sinceLastRead` dice cuánto cambiaron la liquidez, el precio y los compradores. Al comprar se guardan `readsBeforeBuy`, `minutesBetweenReads`, `liquidityTrendPct` y `netBuyersTrend`.
- **Condiciones para tus creencias.** Todos se pueden usar: `volume1hJupiterVsDexRatio`, `creatorTokens`, `creatorGraduated`, `creatorGraduationPct`, `creatorTradesWithYou`, `creatorWorstPnlWithYouPct`, `devHoldingPct`, `creatorHoneypots`, `insidersDetected`, `lpLockedPct` y `launchpad`.

## 6. Futuros perpetuos (simulados con datos de Hyperliquid)

- **Qué son.** `open_perp` abre una posición larga (ganas si sube) o corta (ganas si baja) con apalancamiento sobre BTC, ETH, SOL, BNB y muchas más. Es la única forma de ganar cuando el mercado cae. `close_perp` la cierra. Las abiertas salen en `portfolio`, en `perps`.
- **Apalancamiento máximo por moneda** (dato de Hyperliquid): BTC 40x, ETH 25x, SOL 20x, BNB 10x…
- **De dónde sale el margen.** Del efectivo (USDC/USDT) de una de tus cadenas, y al cerrar vuelve a ella.
- **Costes.** Depósito 0,3 $; comisión del 0,045 % del nocional al abrir y al cerrar; funding cada hora (si es positivo, los largos pagan a los cortos); retirada 1 $.
- **Liquidación.** Si el capital de la posición (margen + resultado − funding) baja del mantenimiento (la mitad del margen inicial al apalancamiento máximo), pierdes el margen. Con SOL (máximo 20x): a 10x, un ~7,5 % en contra; a 20x, solo un ~2,5 %. La respuesta de `open_perp` da el precio de liquidación.
- **Take profit y stop loss.** Son opcionales y se vigilan solos. Se pueden fijar al abrir o después con `set_perp_exits` (con el precio de entrada real; 0 quita la salida).
- **Lo que no se simula:** el slippage exacto en momentos de mucha volatilidad ni las cascadas de liquidaciones. En misiones reales no están disponibles.
- **Cuándo encaja.** `strategy_fit` calcula, para tu objetivo y el tiempo que queda, la probabilidad de llegar con cada apalancamiento y el riesgo de liquidación, con la volatilidad real de ahora.

## 7. Misiones rápidas (15 minutos o menos)

Mediciones con datos reales (29-30 de septiembre de 2026), no predicciones. `strategy_fit` trae la tabla y la frontera: en cada plazo, el objetivo más alto con una P de al menos el 10, el 25 y el 50 %.

- **Cómo se juegan.** Las planifica un agente (el planner) antes del reloj, con un plan de reglas fijo durante 20 misiones de la misma clase (mercado × plazo × objetivo; `get_plan`). Otro (el executor) espera el evento con `wait_for_signal` sin arrancar el reloj y entra con `enter_with_exits`: una compra con todo y la toma de beneficio en el objetivo en la misma llamada. Si no salta, se vende al acabar el reloj.
- **Por qué una sola compra con todo y la venta puesta.** En un juego desfavorable, la probabilidad de llegar a una meta es máxima apostando fuerte y pocas veces (Dubins y Savage), también con tiempo límite. Lo confirman los datos: operar a trozos de ±10 % no llegó nunca a ×2 en 5-15 min con memecoins; repartir en dos tokens con +25 % cada uno exige que acierten los dos (≈12 %); un stop mejora el valor esperado menos de 1 punto y solo puede bajar la P.
- **P medida** de llegar al objetivo con un token de pump.fun recién graduado (migrado a PumpSwap hace 2 min o menos), comprado 1-2 min después de migrar:

| Plazo | +25 % | +50 % | ×2 |
|---|---|---|---|
| 5 min | 24 % | 11 % | 5 % |
| 10 min | 35 % | 21 % | 9 % |
| 15 min | 37 % | 25 % | 14 % |
| 30 min | 39 % | 26 % | 17 % |

- **Qué dice y qué no.**
  - Son 925 tokens de un solo día, sin repetir fuera de muestra. Lo verificado dos veces (momentum: la primera vela de 1 min que sube un 25 % o más) da la mitad: +25 % en 10 min, 16-19 %. Comprar cualquier lanzamiento en su minuto 1: 4-7 %.
  - El valor esperado es negativo en todas las casillas: con costes reales, entre −7 y −28 % por misión.
  - Futuros (réplica del simulador, 50 $ en una cadena): ×2 en 30 min o menos ≈0; +25 % en 15 min, 0,6 % (7,6 % solo con la volatilidad de la última hora en su 1 % más alto).
  - Los aciertos llegan a los 4 min de mediana, y cada minuto de retraso al entrar resta 3-4 puntos de P (comprando 1, 2 o 3 min después de la migración: 35, 32 y 28 %).
- **Optimismos del simulador** que más pesan en misiones de 5-15 min, de más a menos:
  1. Sin latencia ni MEV en los primeros minutos de un token, que es cuando más mandan los bots.
  2. La toma de beneficio (una orden límite) se llena exactamente a su precio y se mira cada 5 s, así que la P puede acercarse a la de tocar la mecha dentro del minuto: +25 % en 10 min, hasta ≈51 %; ×2, ≈17 %. En pump.fun y PumpSwap no hay órdenes límite nativas.
  3. Costes: cobra 0,0001 SOL de red por transacción (en real, 0,0005-0,001) y devuelve la renta de la cuenta del token. Son ≈3,4 puntos por ida y vuelta con 10 $ y ≈0,7 con 50 $.
  4. El impacto en el precio: el coste real de ida y vuelta medido fue del 1,6 al 10,2 %, mientras Jupiter decía 0,02 %.
  5. El suelo de la curva de pump.fun no existe para ~22 % de los tokens: no siempre se puede vender "en el suelo".
- **La línea base.** Cada misión rápida guarda la P que esperaba el plan y la de la tabla, y un gemelo mecánico hace la misma compra con la misma toma de beneficio en los 3 eventos siguientes, en la misma franja y solo con los filtros mecánicos (los de `wait_for_signal` por defecto: liquidez de 1.000 $ o más e ida y vuelta del 10 % o menos): así se mide si el agente aporta algo. Sus 3 gemelos comparten franja, así que su intervalo se calcula por misión, no por gemelo. Con menos de 20 misiones por clase no se distingue la suerte de la habilidad (7 aciertos de 20 dejan un intervalo del 18 al 57 %).
