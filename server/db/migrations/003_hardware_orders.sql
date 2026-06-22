CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'gbp',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::integer),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::integer)
);

INSERT INTO products (id, name, slug, price, currency, active)
VALUES ('screenfizz-player', 'ScreenFizz Player', 'screenfizz-player', 9900, 'gbp', 1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hardware_orders (
    id BIGSERIAL PRIMARY KEY,
    order_number TEXT UNIQUE,
    user_id TEXT,
    stripe_session_id TEXT NOT NULL UNIQUE,
    stripe_payment_intent TEXT,
    stripe_refund_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    vat_number TEXT,
    shipping_address_line1 TEXT NOT NULL DEFAULT '',
    shipping_address_line2 TEXT,
    city TEXT NOT NULL DEFAULT '',
    postcode TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'gbp',
    status TEXT NOT NULL DEFAULT 'paid',
    tracking_number TEXT,
    courier TEXT,
    notes TEXT,
    shipped_email_sent_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::integer),
    updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::integer)
);
CREATE INDEX IF NOT EXISTS idx_hardware_orders_user ON hardware_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hardware_orders_email ON hardware_orders(customer_email, created_at);
CREATE INDEX IF NOT EXISTS idx_hardware_orders_status ON hardware_orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::integer)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
