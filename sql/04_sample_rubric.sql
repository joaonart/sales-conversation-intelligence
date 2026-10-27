-- Example only: user-managed rubric rows should be validated before publishing.
INSERT INTO `PROJECT_ID.conversation_config.evaluation_rubrics`
 (organization_id,workspace_id,rubric_id,version,name,status,published_at,created_at,description)
VALUES ('demo','default','sales_quality',1,'Qualidade comercial','PUBLISHED',CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP(),'Exemplo');
INSERT INTO `PROJECT_ID.conversation_config.evaluation_criteria`
 (organization_id,workspace_id,rubric_id,rubric_version,criterion_id,criterion_name,evaluation_instructions,evaluation_type,weight,required,enabled,score_mapping,display_order)
VALUES
 ('demo','default','sales_quality',1,'greeting','Saudação','O vendedor cumprimentou adequadamente?','PREDICATE',10,FALSE,TRUE,JSON '{"true":100,"false":0}',1),
 ('demo','default','sales_quality',1,'needs','Necessidade','O vendedor identificou a necessidade do cliente?','SCORE',25,TRUE,TRUE,JSON '{"none":0,"partial":50,"complete":100}',2),
 ('demo','default','sales_quality',1,'product','Produto','Informações do produto corretas?','SCORE',20,TRUE,TRUE,JSON '{"poor":0,"fair":50,"good":100}',3),
 ('demo','default','sales_quality',1,'objections','Objeções','Tratou as objeções de modo adequado?','SCORE',25,FALSE,TRUE,JSON '{"poor":0,"fair":50,"good":100}',4),
 ('demo','default','sales_quality',1,'closing','Fechamento','Houve tentativa apropriada de fechamento?','PREDICATE',20,FALSE,TRUE,JSON '{"true":100,"false":0}',5);
