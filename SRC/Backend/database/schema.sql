-- ==============================================================================
-- Esquema PostgreSQL Endurecido (DevSecOps) para Supabase.
-- Incluye: Tablas Multi-tenant, Indices, Auditoria, Separacion de Privilegios y RLS.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL UNIQUE,
    legal_name VARCHAR(200) NOT NULL,
    rtn VARCHAR(40) NOT NULL,
    country_code CHAR(2) NOT NULL DEFAULT 'HN',
    country_name VARCHAR(80) NOT NULL DEFAULT 'Honduras',
    locale VARCHAR(12) NOT NULL DEFAULT 'es-HN',
    currency_code CHAR(3) NOT NULL DEFAULT 'HNL',
    currency_symbol VARCHAR(8) NOT NULL DEFAULT 'L',
    tax_id_label VARCHAR(20) NOT NULL DEFAULT 'RTN',
    tax_id VARCHAR(40) NOT NULL DEFAULT '',
    tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 15,
    city VARCHAR(120) NOT NULL DEFAULT 'Tegucigalpa',
    active SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(120) NOT NULL,
    last_name VARCHAR(120) NOT NULL,
    second_last_name VARCHAR(120),
    email VARCHAR(180) NOT NULL UNIQUE,
    username VARCHAR(80) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL DEFAULT '',
    password_hash VARCHAR(255),
    company VARCHAR(160),
    company_id INT,
    role VARCHAR(40) NOT NULL DEFAULT 'Empleado',
    is_global_admin SMALLINT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'Activo',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_requests (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(120) NOT NULL,
    last_name VARCHAR(120) NOT NULL,
    second_last_name VARCHAR(120),
    email VARCHAR(180) NOT NULL,
    username VARCHAR(80) NOT NULL,
    password VARCHAR(255) NOT NULL DEFAULT '',
    password_hash VARCHAR(255),
    company VARCHAR(160),
    company_id INT NOT NULL,
    role VARCHAR(40) NOT NULL DEFAULT 'Empleado',
    status VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    decided_by INT,
    decided_at TIMESTAMP,
    rejection_reason VARCHAR(300),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_recovery_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(120) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_datasets (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    module_key VARCHAR(40) NOT NULL,
    view_key VARCHAR(40) NOT NULL,
    rows_json TEXT NOT NULL,
    updated_by INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_business_dataset UNIQUE (
        company_id,
        module_key,
        view_key
    )
);

CREATE TABLE IF NOT EXISTS business_serial_sequences (
    company_id INT NOT NULL,
    module_key VARCHAR(40) NOT NULL,
    view_key VARCHAR(40) NOT NULL,
    next_value BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_id, module_key, view_key)
);

CREATE TABLE IF NOT EXISTS employees (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    seed_key VARCHAR(80),
    first_name VARCHAR(120) NOT NULL,
    last_name VARCHAR(120) NOT NULL,
    second_last_name VARCHAR(120),
    email VARCHAR(180) NOT NULL,
    birth_date DATE,
    birth_place VARCHAR(120),
    gender VARCHAR(30) NOT NULL DEFAULT 'No especificado',
    identity_number VARCHAR(255),
    tax_number VARCHAR(255),
    social_security_number VARCHAR(255),
    identity_blind_index VARCHAR(100),
    position VARCHAR(120) NOT NULL,
    branch VARCHAR(120) NOT NULL,
    system_role VARCHAR(40) NOT NULL DEFAULT 'Empleado',
    status VARCHAR(30) NOT NULL DEFAULT 'Activo',
    created_by INT,
    deleted_by INT,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_employee_email_company UNIQUE (company_id, email),
    CONSTRAINT uq_employee_seed_company UNIQUE (company_id, seed_key)
);

CREATE TABLE IF NOT EXISTS accounting_balances (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    period CHAR(7) NOT NULL,
    account_code VARCHAR(30) NOT NULL,
    account_name VARCHAR(180) NOT NULL,
    account_type VARCHAR(40) NOT NULL,
    opening_balance DECIMAL(18, 2) NOT NULL DEFAULT 0,
    debit DECIMAL(18, 2) NOT NULL DEFAULT 0,
    credit DECIMAL(18, 2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_accounting_balance UNIQUE (
        company_id,
        period,
        account_code
    )
);

CREATE TABLE IF NOT EXISTS payroll_concepts (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    concept_key VARCHAR(20) NOT NULL,
    description VARCHAR(180) NOT NULL,
    status VARCHAR(30) NOT NULL,
    integrates_salary VARCHAR(10) NOT NULL,
    calculation_scope VARCHAR(30) NOT NULL,
    benefit VARCHAR(10) NOT NULL,
    movement_type VARCHAR(20) NOT NULL,
    accumulated DECIMAL(18, 2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_payroll_concept UNIQUE (company_id, concept_key)
);

CREATE TABLE IF NOT EXISTS sales_profit_lines (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    period CHAR(7) NOT NULL,
    product_code VARCHAR(40) NOT NULL,
    description VARCHAR(180) NOT NULL,
    quantity DECIMAL(18, 2) NOT NULL DEFAULT 0,
    total_cost DECIMAL(18, 2) NOT NULL DEFAULT 0,
    total_price DECIMAL(18, 2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_sales_profit_line UNIQUE (
        company_id,
        period,
        product_code
    )
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NOT NULL,
    invoice_number VARCHAR(50) NOT NULL,
    supplier VARCHAR(180) NOT NULL,
    issue_date DATE NOT NULL,
    due_date DATE,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(30) NOT NULL DEFAULT 'Recibida',
    net_weight DECIMAL(18, 2) NOT NULL DEFAULT 0,
    gross_weight DECIMAL(18, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_purchase_invoice UNIQUE (company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL,
    work_order VARCHAR(30) NOT NULL,
    style_code VARCHAR(30) NOT NULL,
    description VARCHAR(180) NOT NULL,
    color VARCHAR(80),
    quantity DECIMAL(18, 2) NOT NULL DEFAULT 0,
    unit VARCHAR(10) NOT NULL,
    unit_price DECIMAL(18, 4) NOT NULL DEFAULT 0,
    line_total DECIMAL(18, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS security_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    company_id INT NULL,
    user_id INT NULL,
    action VARCHAR(80) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'INFO',
    ip_address VARCHAR(80) NULL,
    details_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);
CREATE INDEX IF NOT EXISTS idx_registration_status_company ON registration_requests (status, company_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_employee_company_status ON employees (company_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_lines ON purchase_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_company_date ON security_audit_logs (company_id, created_at DESC);

INSERT INTO
    companies (
        code,
        name,
        legal_name,
        rtn,
        country_code,
        country_name,
        locale,
        currency_code,
        currency_symbol,
        tax_id_label,
        tax_id,
        tax_rate,
        city
    )
VALUES (
        'VICMAR_HN',
        'Vicmar',
        'Telas Americanas Vicmar, S. de R.L.',
        '0801-2024-166420',
        'HN',
        'Honduras',
        'es-HN',
        'HNL',
        'L',
        'RTN',
        '0801-2024-166420',
        15,
        'Villanueva, Cortes'
    ),
    (
        'TELAS_OLIMPICA_MX',
        'Telas Olímpica',
        'Telas Olímpica, S.A. de C.V.',
        'TELAS',
        'MX',
        'México',
        'es-MX',
        'MXN',
        '$',
        'RFC',
        'TELAS',
        16,
        'Ciudad de México'
    ),
    (
        'GRUPO_CIRSA_HN',
        'Grupo Cirsa',
        'Grupo Cirsa, S. de R.L.',
        '0801-2026-104521',
        'HN',
        'Honduras',
        'es-HN',
        'HNL',
        'L',
        'RTN',
        '0801-2026-104521',
        15,
        'Tegucigalpa, Francisco Morazan'
    ) ON CONFLICT (code) DO
UPDATE
SET
    name = EXCLUDED.name,
    legal_name = EXCLUDED.legal_name,
    tax_id = EXCLUDED.tax_id;

-- ==============================================================================
-- PUNTO 3: SEPARACION DE PRIVILEGIOS (ROL DE APLICACION DE MINIMO PRIVILEGIO)
-- ==============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backend_user') THEN
        CREATE ROLE app_backend_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_backend_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backend_user;

-- ==============================================================================
-- PUNTO 4: ROW LEVEL SECURITY (RLS) ESTRICTO EN TODAS LAS TABLAS DE SUPABASE
-- ==============================================================================
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE password_recovery_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_recovery_tokens FORCE ROW LEVEL SECURITY;

ALTER TABLE business_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_datasets FORCE ROW LEVEL SECURITY;

ALTER TABLE business_serial_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_serial_sequences FORCE ROW LEVEL SECURITY;

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

ALTER TABLE accounting_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_balances FORCE ROW LEVEL SECURITY;

ALTER TABLE payroll_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_concepts FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_profit_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_profit_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoices FORCE ROW LEVEL SECURITY;

ALTER TABLE purchase_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoice_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE security_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_logs FORCE ROW LEVEL SECURITY;

-- Politicas RLS:
-- 1. companies: lectura de empresas activas permitida al servicio backend
DROP POLICY IF EXISTS rls_companies_isolation ON companies;
CREATE POLICY rls_companies_isolation ON companies
    FOR ALL
    USING (
        current_user IN ('postgres', 'app_backend_user')
        OR current_setting('app.backend_service', true) = 'true'
    );

-- 2. Tablas con aislamiento estricto por company_id
DROP POLICY IF EXISTS rls_users_tenant_isolation ON users;
CREATE POLICY rls_users_tenant_isolation ON users
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_registration_requests_isolation ON registration_requests;
CREATE POLICY rls_registration_requests_isolation ON registration_requests
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_auth_sessions_backend_only ON auth_sessions;
CREATE POLICY rls_auth_sessions_backend_only ON auth_sessions
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
    );

DROP POLICY IF EXISTS rls_recovery_tokens_backend_only ON password_recovery_tokens;
CREATE POLICY rls_recovery_tokens_backend_only ON password_recovery_tokens
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
    );

DROP POLICY IF EXISTS rls_business_datasets_isolation ON business_datasets;
CREATE POLICY rls_business_datasets_isolation ON business_datasets
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_serial_sequences_isolation ON business_serial_sequences;
CREATE POLICY rls_serial_sequences_isolation ON business_serial_sequences
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_employees_isolation ON employees;
CREATE POLICY rls_employees_isolation ON employees
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_accounting_balances_isolation ON accounting_balances;
CREATE POLICY rls_accounting_balances_isolation ON accounting_balances
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_payroll_concepts_isolation ON payroll_concepts;
CREATE POLICY rls_payroll_concepts_isolation ON payroll_concepts
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_sales_profit_lines_isolation ON sales_profit_lines;
CREATE POLICY rls_sales_profit_lines_isolation ON sales_profit_lines
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_purchase_invoices_isolation ON purchase_invoices;
CREATE POLICY rls_purchase_invoices_isolation ON purchase_invoices
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::INT
    );

DROP POLICY IF EXISTS rls_purchase_invoice_lines_isolation ON purchase_invoice_lines;
CREATE POLICY rls_purchase_invoice_lines_isolation ON purchase_invoice_lines
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
    );

DROP POLICY IF EXISTS rls_security_audit_logs_isolation ON security_audit_logs;
CREATE POLICY rls_security_audit_logs_isolation ON security_audit_logs
    FOR ALL
    USING (
        current_user = 'postgres'
        OR current_setting('app.backend_service', true) = 'true'
        OR current_setting('app.is_global_admin', true) = 'true'
    );
