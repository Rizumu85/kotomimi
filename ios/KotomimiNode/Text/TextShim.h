// A text model in this process, by llama.cpp, in C for Swift: iOS starts no programs of an app's own, so where the
// Android app starts llama.cpp's server, this app links llama.cpp and asks it here. What a request becomes is
// what that server makes of it: the model's own chat template, rendered by llama.cpp's common library
// (`common_chat_templates_apply`), and what the model wrote parsed back the same way (`common_chat_parse`), its
// thinking taken out.
#ifndef KOTOMIMI_TEXT_SHIM_H
#define KOTOMIMI_TEXT_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct kt_model kt_model;

typedef struct {
    const char *role;
    const char *content;
} kt_message;

typedef struct {
    float temperature;
    float top_p;
    int top_k;
    float repeat_penalty;
    unsigned int seed;
    int max_tokens;
    /// -1: as the template has it; 0 or 1: `enable_thinking` told to the template.
    int enable_thinking;
    const char *const *stops;
    int stop_count;
    /// PLaMo 3 Translate's languages, told to its template (`source_lang`, `target_lang`); NULL where not told.
    const char *source_lang;
    const char *target_lang;
} kt_settings;

typedef struct {
    /// 0: the model ended it; 1: cut at `max_tokens`; 2: stopped by `cancel`.
    int finish;
    int read_tokens;
    int written_tokens;
    double read_ms;
    double written_ms;
} kt_outcome;

/// Once, before anything else.
void kt_backend_init(void);

/// A model loaded onto the GPU with a context of `context` tokens; NULL, with the reason in `error`, where it is not.
kt_model *kt_model_load(const char *path, int context, char *error, int error_length);
void kt_model_free(kt_model *model);

/// One answer: the text (free it with `kt_free`), or NULL with the reason in `error`. `cancel` is looked at between
/// tokens: set to nonzero, the answer stops there. Not to be called on one model from two threads at once.
char *kt_answer(kt_model *model, const kt_message *messages, int count, kt_settings settings, kt_outcome *outcome,
                volatile int *cancel, char *error, int error_length);
void kt_free(char *text);

#ifdef __cplusplus
}
#endif

#endif
