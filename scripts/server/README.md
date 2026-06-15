# aaa-hub deploy

Linux only. Built by `scripts/server/build-release.sh`.

## Layout (after extraction)

```
aaa-hub-<ver>-linux-x86_64/
├── aaa-hub                 # bare binary
├── migrations/             # sqlx migrations (loaded at runtime, relative path)
├── admin-ui/               # static admin pages served at /admin
├── config.toml.example     # template
└── README.md               # this file
```

## First-time setup

```bash
tar -xzf aaa-hub-<ver>-linux-x86_64.tar.gz
cd aaa-hub-<ver>-linux-x86_64/
cp config.toml.example config.toml
vim config.toml             # set bind, public_url, admin_token, etc.
mkdir -p $(awk -F\" '/^data_dir/{print $2}' config.toml)
AAA_HUB_CONFIG=./config.toml ./aaa-hub
```

> ⚠️ Working directory must be the dist root because `migrations/` is loaded
> via a relative path baked into the binary (`sqlx::migrate!("./migrations")`).

## systemd unit

`/etc/systemd/system/aaa-hub.service`:

```ini
[Unit]
Description=aaa-hub
After=network.target

[Service]
Type=simple
User=aaa-hub
WorkingDirectory=/opt/aaa-hub
Environment=AAA_HUB_CONFIG=/opt/aaa-hub/config.toml
ExecStart=/opt/aaa-hub/aaa-hub
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/aaa-hub aaa-hub
sudo cp -r aaa-hub-<ver>-linux-x86_64/* /opt/aaa-hub/
sudo chown -R aaa-hub:aaa-hub /opt/aaa-hub
sudo systemctl daemon-reload
sudo systemctl enable --now aaa-hub
```

## nginx reverse proxy (optional)

```nginx
location /v1/ { proxy_pass http://127.0.0.1:8080; }
location /admin { proxy_pass http://127.0.0.1:8080; }
location /healthz { proxy_pass http://127.0.0.1:8080; }
```
