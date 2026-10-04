-- Keep the exact selected recipient proofs when an active roster is archived.
-- Existing encrypted objects, signatures and quota charges are retained.
ALTER TABLE needware_document_epoch ADD COLUMN IF NOT EXISTS recipient_certificates jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE needware_document_epoch e SET recipient_certificates=COALESCE((
  SELECT jsonb_agg(item->'certificate' ORDER BY item->>'account_id',item->>'device_id')
  FROM jsonb_array_elements(e.members) item WHERE item ? 'certificate'
),'[]'::jsonb) WHERE recipient_certificates='[]'::jsonb
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.members) item WHERE item ? 'certificate');
