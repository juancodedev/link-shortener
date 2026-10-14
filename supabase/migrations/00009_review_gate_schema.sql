-- Migration 00009: Review gate schema — tag_ratings and tag_feedback
--
-- What a customer does on the dual-path action screen:
--
--   "Publicar Reseña en Google"   → action_taken = 'google_redirect'
--   "Enviar Comentario Privado"  → action_taken = 'internal_feedback'
--
-- Both options are always visible and the Google URL is never withheld. This
-- schema records the choice, not a sentiment-based routing decision.
--
-- WHY analytics.* AND NOT THE TENANT SCHEMA:
-- The dashboard has to answer "how many scans did each table get, and how did
-- the customers who went to Google rate us" across every link of a tenant in
-- one query. A per-tenant table would make that N queries. `analytics.link_clicks`
-- already established the pattern: transactional data in the tenant schema,
-- cross-link analysis in a shared schema.
--
-- WHY THESE TABLES CARRY A FOREIGN KEY TO public.locations WHEN links.location_id
-- DOES NOT:
-- `links` lives in a tenant schema that is dropped with the tenant, and
-- public.locations cascades from the same public.tenants row — so a constraint
-- there guarded nothing, and ADD CONSTRAINT has no idempotent form. These two
-- tables are the opposite case: they live in a shared schema and SURVIVE the
-- drop of any tenant schema. Without the FK, a location deleted from a tenant
-- would leave ratings pointing at nothing, and the rollup would silently
-- miscount.
--
-- WHY rating IS NULLABLE:
-- Stars are an optional sentiment signal collected alongside the action, not
-- the branch. A customer who taps "Publicar Reseña" without rating is the
-- common case, and requiring a rating would add a step to the path the product
-- exists to make fast. `action_taken` is the required column.
--
-- The resulting "sentiment gap" — mean rating among google_redirect minus mean
-- rating among internal_feedback — is a leading indicator of public review
-- sentiment that neither a sentiment-gated flow nor a bare two-button screen
-- could produce.
--
-- IDEMPOTENT BY CONSTRUCTION: every CREATE is IF NOT EXISTS, every version
-- record is ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS analytics.tag_ratings (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    UUID NOT NULL
                 REFERENCES public.tenants(id) ON DELETE CASCADE,
    link_id      UUID NOT NULL,          -- Logical reference; no FK (tenant schema)
    location_id  UUID
                 REFERENCES public.locations(id) ON DELETE SET NULL,
    rating       INTEGER,                -- Optional 1..5 sentiment signal
    action_taken TEXT NOT NULL
                 CHECK (action_taken IN ('google_redirect', 'internal_feedback')),
    scanned_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT tag_ratings_rating_range
        CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5))
);

CREATE TABLE IF NOT EXISTS analytics.tag_feedback (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id        UUID NOT NULL
                     REFERENCES public.tenants(id) ON DELETE CASCADE,
    link_id          UUID NOT NULL,      -- Logical reference; no FK (tenant schema)
    location_id      UUID
                     REFERENCES public.locations(id) ON DELETE SET NULL,
    rating           INTEGER,
    comment          TEXT NOT NULL,
    customer_contact TEXT,               -- Optional email or phone, free text
    scanned_at       TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT tag_feedback_rating_range
        CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5))
);

-- Per-tenant rollups over time — the dashboard's primary query shape
CREATE INDEX IF NOT EXISTS idx_tag_ratings_tenant_time
    ON analytics.tag_ratings(tenant_id, scanned_at DESC);

-- Per-link time series
CREATE INDEX IF NOT EXISTS idx_tag_ratings_link_time
    ON analytics.tag_ratings(link_id, scanned_at DESC);

-- Per-zone rollups ("which table converts"). Sparse: a scan only carries a
-- location once the owner has placed the sticker.
CREATE INDEX IF NOT EXISTS idx_tag_ratings_location
    ON analytics.tag_ratings(location_id);

-- Unread feedback queue for the business owner
CREATE INDEX IF NOT EXISTS idx_tag_feedback_tenant_time
    ON analytics.tag_feedback(tenant_id, scanned_at DESC);

-- Record this migration in the analytics schema (last was 2, 00003)
INSERT INTO analytics._migrations (version, name)
VALUES (3, '00009_review_gate_schema')
ON CONFLICT (version) DO NOTHING;