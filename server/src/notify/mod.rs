use crate::domain::feedback::NewFeedback;

pub mod email;

#[async_trait::async_trait]
pub trait Notifier: Send + Sync {
    async fn feedback_created(&self, ticket_id: &str, fb: &NewFeedback);
}

pub struct NoopNotifier;

#[async_trait::async_trait]
impl Notifier for NoopNotifier {
    async fn feedback_created(&self, _: &str, _: &NewFeedback) {}
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default, Clone)]
    pub struct CountingNotifier {
        pub n: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl Notifier for CountingNotifier {
        async fn feedback_created(&self, _: &str, _: &NewFeedback) {
            self.n.fetch_add(1, Ordering::SeqCst);
        }
    }
}
