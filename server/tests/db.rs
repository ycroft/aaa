use aaa_hub::db;
use sqlx::Row;

#[tokio::test]
async fn pool_runs_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = db::open(&db_path).await.unwrap();
    let row = sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("name"), "feedback");
}
