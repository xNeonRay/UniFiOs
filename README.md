# UniFiOs Captive Portal API

Sistema completo de portal cautivo para **UniFiOs / Network Application 10.2.x** (compatible con versiones 7.x en adelante).

---

## Características

| # | Característica |
|---|----------------|
| 1 | **Página de portal cautivo** con canje de vouchers, chatbot integrado y diseño responsive (Mac / iOS / Android / Windows) |
| 2 | **Autorización por MAC** por sitio y/o red |
| 3 | **Creación de vouchers** — local y sincronización con la consola UniFi |
| 4 | **Validación de SSID** — un voucher puede bloquearse a una red específica para evitar uso en otras redes |
| 5 | **Tablas de datos** — usuarios, dispositivos, vouchers, usos (un usuario puede tener varios dispositivos) |
| 6 | **Verificación post-autorización** — detecta si el AP aún no sincronizó e intenta reautorizar; informa al usuario si el acceso no se confirma |
| 7 | **Panel de administración** — gestión de vouchers, usuarios y dispositivos |

---

## Estructura

```
UniFiOs/
├── api/
│   ├── config.php                  # Configuración principal (env vars / defines)
│   ├── config.local.example.php    # Plantilla para configuración local (git-ignorada)
│   ├── helpers.php                 # Funciones comunes, CORS, respuestas JSON
│   ├── index.php                   # Router de la API
│   ├── lib/
│   │   ├── db.php                  # Conexión SQLite y schema
│   │   └── UniFiController.php     # Wrapper del controlador UniFi (sin dependencias externas)
│   └── endpoints/
│       ├── authorize.php           # POST /api/authorize
│       ├── vouchers.php            # GET/POST/DELETE /api/vouchers
│       ├── users.php               # CRUD /api/users
│       ├── devices.php             # CRUD /api/devices
│       ├── chat.php                # POST /api/chat/*
│       ├── verify.php              # GET /api/verify/<mac>
│       └── sites.php               # GET /api/sites
├── portal/
│   ├── index.php                   # Portal cautivo (canje de voucher + chatbot)
│   └── assets/
│       ├── portal.css
│       └── portal.js
├── admin/
│   ├── index.html                  # Panel de administración
│   └── assets/
│       ├── admin.css
│       └── admin.js
├── database/                       # SQLite (git-ignorado, creado automáticamente)
├── .htaccess                       # Routing y seguridad
└── README.md
```

---

## Instalación rápida

### Requisitos
- PHP 8.0+ con extensiones: `pdo_sqlite`, `curl`, `json`
- Servidor web con `mod_rewrite` (Apache) **o** configurar rutas manualmente en Nginx
- Acceso al controlador UniFi (UniFiOs 10.2.x recomendado)

### Pasos

1. **Clonar/copiar** los archivos a tu servidor web.

2. **Crear configuración local:**
   ```bash
   cp api/config.local.example.php api/config.local.php
   nano api/config.local.php
   ```
   Rellena los datos del controlador UniFi, la API key de administrador y (opcional) la URL de tu webhook de chatbot.

3. **Permisos:**
   ```bash
   chmod 755 database/
   chown www-data:www-data database/     # o el usuario de tu servidor web
   ```

4. **Configurar el portal cautivo en UniFi:**
   - Ve a: *Settings → Networks → [tu red] → Guest Access → External Portal*
   - URL del portal: `https://tu-servidor/portal/?site=default`
   - Asegúrate de que el subdominio/IP del servidor esté en la lista blanca de UniFi.

5. **(Opcional) Variables de entorno** en vez de config.local.php:
   ```bash
   UNIFI_HOST=https://192.168.1.1
   UNIFI_PORT=443
   UNIFI_USER=admin
   UNIFI_PASS=tu-contraseña
   UNIFI_SITE=default
   UNIFI_VERSION=8
   API_KEY=tu-api-key-secreta
   CHATBOT_WEBHOOK_URL=https://tu-webhook.example.com/chat
   ```

---

## API Reference

> Todos los endpoints de administración requieren el header `X-API-Key: <tu-api-key>`.

### Autorizar dispositivo
```
POST /api/authorize
Content-Type: application/json

{
  "mac":       "aa:bb:cc:dd:ee:ff",
  "ap_mac":    "11:22:33:44:55:66",   // opcional
  "site":      "default",             // opcional
  "ssid":      "MI_RED",              // opcional
  "minutes":   480                    // opcional (defecto: 480)
}
```

### Crear vouchers (admin)
```
POST /api/vouchers
X-API-Key: <key>

{
  "count":            5,
  "duration_minutes": 480,
  "max_uses":         1,
  "quota_mb":         1024,          // opcional
  "site":             "default",
  "ssid":             "INVITADOS",   // restringe voucher a esa SSID
  "sync_unifi":       true           // crea también en el controlador
}
```

### Canjear voucher (portal cautivo, público)
```
POST /api/vouchers/redeem

{
  "code": "ABCDE-FGHIJ",
  "mac":  "aa:bb:cc:dd:ee:ff",
  "ssid": "INVITADOS",
  "site": "default"
}
```

### Verificar acceso a internet
```
GET /api/verify/aa:bb:cc:dd:ee:ff?site=default
```

### Chat — iniciar sesión
```
POST /api/chat/start

{
  "webhook_url": "https://mi-webhook.com/chat"  // opcional
}
```

### Chat — enviar mensaje
```
POST /api/chat/message

{
  "session_id": "<id-de-sesión>",
  "message":    "Hola, necesito un voucher"
}
```
El webhook recibirá:
```json
{
  "session_id": "...",
  "message":    "Hola, necesito un voucher",
  "history":    [...]
}
```
Y debe responder con:
```json
{ "reply": "¡Hola! En un momento te ayudo." }
```

### Listar sitios UniFi (admin)
```
GET /api/sites
X-API-Key: <key>
```

---

## Panel de administración

Accede a `/admin/` en tu navegador. Se te pedirá la API key la primera vez (se guarda en `localStorage`).

Funcionalidades:
- **Dashboard** — estadísticas generales
- **Vouchers** — crear, listar, filtrar por site/SSID/estado, eliminar (elimina también del controlador si fue sincronizado)
- **Usuarios** — crear, buscar, eliminar
- **Dispositivos** — ver historial de uso, desautorizar desde UniFi
- **Usos** — historial de canjes

---

## Lógica anti-bucle (req. 6)

Cuando un usuario reporta "ya lo canjeé pero sigo sin internet":

1. Al canjear, el sistema verifica inmediatamente si el dispositivo ya estaba autorizado en UniFi (evita doble canje).
2. Después de autorizar, el sistema hace hasta `AUTH_VERIFY_RETRIES` intentos con `AUTH_VERIFY_DELAY` segundos entre cada uno para confirmar que UniFi reporta el dispositivo como autorizado (mitiga el delay de sincronización del AP).
3. El portal también hace polling desde el cliente JS para confirmar acceso.
4. Si aún no hay confirmación, se indica al usuario que reconecte al WiFi (trigger de re-evaluación en el AP).
5. El endpoint `/api/verify/<mac>` permite polling desde el cliente en cualquier momento.

---

## Validación de SSID (req. 4)

Al crear un voucher con `ssid: "INVITADOS"`, solo puede canjearse mientras el dispositivo está conectado a esa SSID. Si se intenta canjear en una SSID diferente (ej: `CORPORATIVO`), la API devuelve error 403 con mensaje claro.

---

## Seguridad

- La base de datos SQLite se almacena en `/database/` con `.htaccess` que deniega acceso directo.
- `api/config.local.php` está en `.gitignore` y protegido por `.htaccess`.
- La API key de administrador se pasa vía header `X-API-Key` (nunca en la URL en producción).
- Todos los inputs del usuario pasan por `sanitize_mac()`, `htmlspecialchars()` o `filter_var()` antes de usarse.
- Las consultas SQL usan prepared statements con PDO.
- SSL peer verification está activo para el webhook de chat (solo desactivado para el controlador UniFi cuando usa certificado auto-firmado).

---

## Nginx (alternativa a Apache)

Si usas Nginx, agrega este bloque al `server {}` de tu sitio:

```nginx
location /api/ {
    try_files $uri $uri/ /api/index.php$is_args$args;
}

location ~ \.php$ {
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    fastcgi_index index.php;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
}

location ~* \.(sqlite|sqlite-shm|sqlite-wal)$ {
    deny all;
}

location = /api/config.local.php {
    deny all;
}
```

---

## Licencia

MIT — úsalo, modifícalo y compártelo libremente.
