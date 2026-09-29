---
name: cartera
description: Abre la cartera real de la IA (dinero de verdad en Solana, Base y BNB Chain) - crearla, desbloquearla, ver sus direcciones y saldos o pararla. La frase y la contraseña se escriben solo en su página, nunca en el chat.
disable-model-invocation: true
allowed-tools: mcp__plugin_dementeking_cryptosim__start_wallet, mcp__plugin_dementeking_cryptosim__wallet_status
---

Ayuda al usuario con la cartera real de la IA. Habla en español.

1. Si no tienes cargadas las herramientas del servidor `cryptosim`, cárgalas con ToolSearch (`+dementeking`). Si no aparecen, explica que el plugin `dementeking` debe estar activado, y para aquí.
2. Llama a `start_wallet`: arranca el firmante (el proceso que guarda la clave) y abre su página en el navegador.
3. Explica en pocas líneas, según el estado que devuelva:
   - Sin cartera: en la página se crea una nueva, solo para la IA. Verá la frase de recuperación una sola vez: que la apunte en papel. Puede importarla en MetaMask (Base y BNB Chain) y en Phantom (Solana) para ver la cartera.
   - Bloqueada: que escriba su contraseña en la página.
   - Desbloqueada: llama a `wallet_status` y enseña el total, el saldo por cadena y las direcciones.
4. Para darle fondos: que envíe USDC o USDT, y un poco de SOL, ETH o BNB para el gas, a las direcciones de la página, por la red correcta. Recomienda empezar con poco (20 a 50 $) y solo dinero que pueda perder entero.

Reglas:
- Nunca pidas, aceptes ni repitas en el chat la frase de recuperación ni la contraseña. Si el usuario las pega aquí, dile que esa cartera ya no es segura y que cree una nueva.
- Para que el agente opere con este dinero, el usuario crea una misión en modo real con `/dementeking:trading`. En la página de la cartera aprueba las operaciones (si eligió aprobación manual) y tiene el botón "Parar todo".
