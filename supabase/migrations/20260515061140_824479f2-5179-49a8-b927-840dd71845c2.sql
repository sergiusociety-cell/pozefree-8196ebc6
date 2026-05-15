INSERT INTO storage.buckets (id, name, public) VALUES ('kie-refs', 'kie-refs', true) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read kie-refs" ON storage.objects FOR SELECT USING (bucket_id = 'kie-refs');
CREATE POLICY "Authenticated upload kie-refs" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'kie-refs');