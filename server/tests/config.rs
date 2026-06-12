use aaa_hub::config::Config;
use std::io::Write;
use tempfile::NamedTempFile;

#[test]
fn loads_config_from_toml() {
    let mut f = NamedTempFile::new().unwrap();
    writeln!(f, r#"
[server]
bind = "0.0.0.0:9999"
public_url = "https://example.test"
data_dir = "/tmp/aaa-hub-test"
admin_token = "secret"

[updates]
artifacts_dir = "/tmp/aaa-hub-test/artifacts"
pubkey = "PUB"

[uploads]
dir = "/tmp/aaa-hub-test/uploads"
max_attachment_bytes = 1024
allowed_mime = ["image/png"]

[notify.email]
enabled = false
smtp_host = ""
smtp_port = 0
smtp_user = ""
smtp_password = ""
from = ""
to = []

[ratelimit]
feedback_per_ip_per_hour = 10
manifest_per_ip_per_minute = 60
"#).unwrap();
    let cfg = Config::load_from(f.path()).unwrap();
    assert_eq!(cfg.server.bind, "0.0.0.0:9999");
    assert_eq!(cfg.uploads.max_attachment_bytes, 1024);
    assert!(!cfg.notify.email.enabled);
}
