alter table genio_one_distillation_markers
  drop constraint genio_one_distillation_markers_classifier_check;

alter table genio_one_distillation_markers
  add constraint genio_one_distillation_markers_classifier_check
  check (
    classifier_version = 'jev-distillation-1'
    and extractor_version in ('timeline-body-1', 'timeline-visible-2')
  );
