[Unit]
Description=Sharky sim-service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
WorkingDirectory=__WORKDIR__
EnvironmentFile=__WORKDIR__/.env
ExecStart=/usr/bin/env node dist/index.js
Restart=always
RestartSec=3
TimeoutStopSec=30
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
