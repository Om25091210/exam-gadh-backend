-- Everything that is not a draft is frozen: published AND archived versions (attempts are bound to both).
-- The only allowed change is an audited answer-key correction, which sets eg.allow_key_correction = 'on'
-- inside its transaction and may touch nothing but the snapshot.

CREATE OR REPLACE FUNCTION eg_block_published_version_edit() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'draft' AND (
       NEW."durationMin" IS DISTINCT FROM OLD."durationMin" OR
       NEW."correctMarks" IS DISTINCT FROM OLD."correctMarks" OR
       NEW."negativeFraction" IS DISTINCT FROM OLD."negativeFraction" OR
       NEW."qualifyingPct" IS DISTINCT FROM OLD."qualifyingPct" OR
       NEW."qualifyingPctReserved" IS DISTINCT FROM OLD."qualifyingPctReserved" OR
       NEW."maxScore" IS DISTINCT FROM OLD."maxScore" OR
       NEW."questionCount" IS DISTINCT FROM OLD."questionCount" OR
       NEW."sectionalTimers" IS DISTINCT FROM OLD."sectionalTimers") THEN
    RAISE EXCEPTION 'test version % is % and frozen; create a new version instead', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TestVersionQuestion_frozen_when_published" ON "TestVersionQuestion";
CREATE OR REPLACE FUNCTION eg_block_published_questions_edit() RETURNS trigger AS $$
DECLARE v_status "VersionStatus"; v_id uuid;
BEGIN
  v_id := COALESCE(NEW."versionId", OLD."versionId");
  SELECT "status" INTO v_status FROM "TestVersion" WHERE "id" = v_id;
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    IF TG_OP = 'UPDATE' AND current_setting('eg.allow_key_correction', true) = 'on'
       AND NEW."versionId" = OLD."versionId" AND NEW."position" = OLD."position" AND NEW."questionId" = OLD."questionId"
       AND NEW."sectionId" IS NOT DISTINCT FROM OLD."sectionId" AND NEW."marks" IS NOT DISTINCT FROM OLD."marks" THEN
      RETURN NEW; -- only the snapshot (answer key) is changing, as part of an audited correction
    END IF;
    RAISE EXCEPTION 'test version % is % and its questions are frozen', v_id, v_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TestVersionQuestion_frozen_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "TestVersionQuestion" FOR EACH ROW EXECUTE FUNCTION eg_block_published_questions_edit();

CREATE OR REPLACE FUNCTION eg_block_published_sections_edit() RETURNS trigger AS $$
DECLARE v_status "VersionStatus"; v_id uuid;
BEGIN
  v_id := COALESCE(NEW."versionId", OLD."versionId");
  SELECT "status" INTO v_status FROM "TestVersion" WHERE "id" = v_id;
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'test version % is % and its sections are frozen', v_id, v_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TestSection_frozen_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "TestSection" FOR EACH ROW EXECUTE FUNCTION eg_block_published_sections_edit();
