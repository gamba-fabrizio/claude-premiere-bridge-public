/**
 * El transporte: una carpeta compartida con el panel.
 *
 * El panel UXP no puede escuchar en un puerto —no abre sockets servidor—, así
 * que la dirección se invierte: el panel polea una carpeta y nosotros dejamos
 * el comando ahí. Feo, y anduvo a la primera.
 *
 * Tres cosas que salieron de medirlo en Premiere y no de suponerlas:
 *
 *  - Las rutas van CRUDAS. "Bridge Claude-Premiere" tiene un espacio y
 *    getEntryWithUrl lo acepta sin encodeURI. Se probaron las dos formas.
 *  - El panel ejecuta con Premiere adelante y el panel sin foco. UXP no frena
 *    su timer, así que el bridge funciona mientras editás, que es cuando tiene
 *    que funcionar.
 *  - El latido no es decoración. Si el panel está cerrado nadie contesta nunca,
 *    y un comando sin dueño se cuelga hasta el timeout. Mirando la frescura del
 *    latido se contesta "el panel no está abierto" en vez de esperar al pedo.
 */

const fs = require("fs/promises");
const path = require("path");

// Relativa al repo, no al home: mover el repo mueve la carpeta con él. El panel
// NO puede hacer lo mismo —vive adentro de Premiere y no sabe dónde está este
// código—, así que allá la ruta está escrita a mano. Si movés el repo, hay que
// editar RUTA_BRIDGE en plugin/index.js.
const CARPETA = path.join(__dirname, "..", "intercambio");

const ARCHIVO_COMANDO = path.join(CARPETA, "comando.json");
const ARCHIVO_RESPUESTA = path.join(CARPETA, "respuesta.json");
const ARCHIVO_LATIDO = path.join(CARPETA, "latido.json");

// El panel late cada 700ms. Con 5s de margen, un latido viejo significa que el
// panel no está: no es una demora, está cerrado.
const MS_LATIDO_VIEJO = 5000;
// Cuánto se espera a que el latido AVANCE antes de darlo por muerto. Premiere
// ocupado puede tardar más de 10s por vuelta; abajo de eso no es un panel caído.
const MS_ESPERA_LATIDO = 25000;
const MS_TIMEOUT = 30000;
const MS_ENTRE_LECTURAS = 100;

let contador = 0;

function nuevoId() {
  contador += 1;
  return `${Date.now()}-${contador}`;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lee un JSON tolerando que esté a medio escribir.
 *
 * El panel escribe con createFile({overwrite:true}) y después write(), o sea que
 * entre las dos hay un instante donde el archivo existe y está VACÍO. Leerlo
 * justo ahí da un JSON inválido que no es un error: es una carrera normal, y lo
 * que corresponde es reintentar en la próxima vuelta.
 */
async function leerJson(ruta) {
  let texto;
  try {
    texto = await fs.readFile(ruta, "utf8");
  } catch (e) {
    return null; // todavía no existe
  }
  if (!texto.trim()) return null; // pillado a mitad de la escritura
  try {
    return JSON.parse(texto);
  } catch (e) {
    return null; // idem
  }
}

/** Hace cuánto que el panel no late, en ms. Infinity si nunca latió. */
async function edadDelLatido() {
  try {
    const stat = await fs.stat(ARCHIVO_LATIDO);
    return Date.now() - stat.mtimeMs;
  } catch (e) {
    return Infinity;
  }
}

async function asegurarCarpeta() {
  await fs.mkdir(CARPETA, { recursive: true });
}

/**
 * Manda un comando y espera la respuesta.
 *
 * Devuelve lo que contestó el panel. Tira si el panel no está abierto, si no
 * contesta a tiempo, o si contestó con un error — y en los tres casos el mensaje
 * dice QUÉ SE ENCONTRÓ, porque un "falló" pelado no se puede diagnosticar.
 */
async function enviar(cmd, params = {}, msTimeout = MS_TIMEOUT) {
  await asegurarCarpeta();

  /*
   * Un panel LENTO no es un panel MUERTO, y el chequeo confundía las dos cosas.
   *
   * La vuelta escribe el latido y normalmente tarda menos de un segundo, pero
   * con un proyecto grande recién abierto —conformando audio, generando picos—
   * llegó a tardar 11s. Con el umbral de 5s, las llamadas fallaban al azar según
   * cayeran antes o después del latido, y una tanda de cortes se cortaba por la
   * mitad. Pasó dos veces el 2026-08-16 editando el M1.
   *
   * Ahora, si el latido está viejo, se ESPERA a ver si avanza. Que avance
   * prueba que el panel vive; que no avance en todo ese rato es lo que antes
   * significaba el umbral.
   */
  let edad = await edadDelLatido();
  if (edad > MS_LATIDO_VIEJO) {
    const marca = await leerJson(ARCHIVO_LATIDO);
    const vueltaAntes = marca && marca.vuelta;
    const hastaLatido = Date.now() + MS_ESPERA_LATIDO;
    while (Date.now() < hastaLatido) {
      await dormir(500);
      const ahora = await leerJson(ARCHIVO_LATIDO);
      if (ahora && vueltaAntes !== undefined && ahora.vuelta !== vueltaAntes) {
        edad = 0; // avanzó: está vivo, solo lento
        break;
      }
    }
  }
  if (edad > MS_LATIDO_VIEJO) {
    throw new Error(
      edad === Infinity
        ? "El panel del bridge nunca latió. Abrilo en Premiere: Window > Extensions > Claude Bridge."
        : `El panel del bridge no latió en ${Math.round(MS_ESPERA_LATIDO / 1000)}s de espera. ` +
          "Puede estar cerrado, o Premiere puede estar sin responder."
    );
  }

  const id = nuevoId();
  await fs.writeFile(ARCHIVO_COMANDO, JSON.stringify({ id, cmd, params }, null, 2));

  const hasta = Date.now() + msTimeout;
  while (Date.now() < hasta) {
    await dormir(MS_ENTRE_LECTURAS);
    const r = await leerJson(ARCHIVO_RESPUESTA);
    if (r && r.id === id) {
      /*
       * El comando se BORRA una vez contestado.
       *
       * Al recargar el panel en UDT, su `ultimoId` vuelve a cero y lo primero
       * que hace es releer comando.json: si el archivo sigue ahí, ejecuta de
       * nuevo el último comando. Con verbos de lectura era una comodidad —se
       * usaba a propósito para disparar sondas con el Reload—, pero con verbos
       * que crean y borran es una repetición silenciosa. Pasó: un Reload creó
       * una segunda secuencia idéntica.
       */
      try { await fs.unlink(ARCHIVO_COMANDO); } catch (e) { /* ya no estaba */ }
      if (r.error) throw new Error(r.error);
      return r;
    }
  }

  // Distinguir "se cayó mientras trabajaba" de "tardó" ayuda a decidir si
  // reintentar o ir a mirar Premiere.
  const edadFinal = await edadDelLatido();
  throw new Error(
    `El comando "${cmd}" no tuvo respuesta en ${Math.round(msTimeout / 1000)}s. ` +
    (edadFinal > MS_LATIDO_VIEJO
      ? "El panel dejó de latir mientras tanto: mirá si Premiere sigue vivo."
      : "El panel sigue latiendo, así que la operación está tardando o se colgó adentro de Premiere.")
  );
}

module.exports = { enviar, edadDelLatido, CARPETA };
