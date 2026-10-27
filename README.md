# Santorini Club · Sistema de caja

Programa web para registrar las ventas de la discoteca: apertura de caja con el efectivo inicial, ventas por producto en efectivo o transferencia (con foto del capture), cuentas abiertas por mesa o cliente que se cobran al final, salidas de efectivo, cierre de caja con cuadre y el historial de cierres.

- **Administrador**: crea usuarios, agrega y edita productos, anula ventas y ve todos los cierres.
- **Cajero**: abre la caja, vende, lleva cuentas por mesa o cliente, registra salidas y cierra la caja.
- **Datos**: se guardan en la nube con Firebase (Cloud Firestore), así que se ven igual desde cualquier equipo y no se pierden si se borra el navegador. Si se cae el internet, las ventas se guardan en el equipo y se suben solas cuando vuelve la conexión.
- **Página**: se publica gratis con GitHub Pages.

---

## 1. Crear el proyecto en Firebase (una sola vez, ~10 minutos)

1. Entra a <https://console.firebase.google.com> con una cuenta de Google y pulsa **Crear un proyecto**. Ponle un nombre, por ejemplo `santorini-caja`. Google Analytics no es necesario.
2. **Authentication**: menú *Compilación → Authentication → Comenzar*. En *Método de acceso* activa **Correo electrónico/contraseña** y guarda.
3. **Firestore**: menú *Compilación → Firestore Database → Crear base de datos*. Elige la ubicación `southamerica-east1` (São Paulo) o `us-east1` y empieza en **modo de producción**.
4. **Reglas**: en Firestore abre la pestaña **Reglas**, borra lo que hay, pega el contenido completo del archivo [`firestore.rules`](firestore.rules) y pulsa **Publicar**.
5. **Registrar la app web**: ⚙ *Configuración del proyecto → General → Tus apps →* icono `</>`. Ponle un apodo y pulsa *Registrar app* (no hace falta Firebase Hosting). Copia el bloque `firebaseConfig` que aparece.
6. Abre [`firebase-config.js`](firebase-config.js) y reemplaza los valores de ejemplo por los tuyos.

> Los valores de `firebaseConfig` no son contraseñas; es normal que estén en el repositorio público. Lo que protege los datos son las reglas del paso 4.

## 2. Publicar en GitHub Pages

1. Sube estos archivos a un repositorio de GitHub (por ejemplo `santorini-caja`).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)` y **Save**.
3. En uno o dos minutos la página queda en `https://TU-USUARIO.github.io/santorini-caja/`.
4. En Firebase: *Authentication → Configuración → Dominios autorizados → Agregar dominio* y escribe `TU-USUARIO.github.io`.

## 3. Primer ingreso

1. Abre la página. La primera vez aparece **Configuración inicial**: escribe el nombre, usuario y contraseña del administrador. Esto solo se puede hacer una vez.
2. En **Productos** carga la lista de ejemplo o agrega los tuyos, y ajusta precios y stock.
3. En **Usuarios** crea una cuenta para cada cajero.

## Uso diario

1. **Abrir caja**: cuenta el efectivo inicial y escríbelo.
2. **Venta rápida**: toca los productos y pulsa **Cobrar**. En efectivo puedes escribir lo recibido para ver el cambio.
3. **Cuentas por mesa o cliente**: pulsa **+ Cuenta**, elige *Mesa* o *Cliente* y escribe el número o nombre. Con la cuenta seleccionada, cada producto que toques queda anotado en ella. Cuando el cliente se va, pulsa **Cobrar cuenta**. En la pestaña **Cuentas** ves todas las cuentas abiertas y cuánto debe cada una.
4. **Transferencias**: al cobrar elige *Transferencia* y adjunta la foto del capture (o pégala con Ctrl+V). Después se ve en **Movimientos → Ver capture**.
5. **Salidas**: dinero que sale de la caja (hielo, proveedores, propinas).
6. **Cerrar caja**: primero hay que cobrar todas las cuentas abiertas. Luego cuenta el efectivo y escríbelo. El sistema muestra si cuadra, sobra o falta, y deja el resumen listo para copiar a WhatsApp.

## Preguntas frecuentes

- **Un cajero olvidó su contraseña.** El administrador lo desactiva en *Usuarios* y le crea un usuario nuevo. (Firebase no permite que un administrador cambie la contraseña de otra persona desde la página; también puede borrarse la cuenta en *Firebase → Authentication* y crearla de nuevo con el mismo usuario.)
- **¿Dónde se guardan los captures?** En la misma base de datos, reducidos a unos 100–300 KB cada uno. Así no se necesita Firebase Storage ni plan de pago.
- **Cuentas sin internet.** Las ventas rápidas funcionan sin conexión, pero anotar en una cuenta y cobrarla necesita internet, para que dos meseros no se pisen.
- **¿Cuánto cuesta?** Para el volumen de una discoteca, el plan gratuito de Firebase (Spark) y GitHub Pages son suficientes.
- **Respaldo.** Firestore guarda los datos en la nube de Google. Para una copia extra, en Firebase puedes exportar la base desde *Firestore → Importar/Exportar* (requiere plan Blaze).

## Archivos

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` | La página y su diseño |
| `app.js` | Toda la lógica del sistema |
| `firebase-config.js` | La conexión con tu proyecto de Firebase |
| `firestore.rules` | Reglas de seguridad (quién puede leer y escribir qué) |
| `logo.jpg`, `logo-small.jpg` | Logo de Santorini Club |
