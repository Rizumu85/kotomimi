#include "TextShim.h"

#include <chrono>
#include <cstring>
#include <string>
#include <vector>

#include "llama.h"
#include "common/chat.h"
#include "common/common.h"
#include "common/sampling.h"

struct kt_model {
    llama_model *model = nullptr;
    llama_context *context = nullptr;
    common_chat_templates_ptr templates;
    int size = 0;
};

static void say(char *error, int length, const std::string &why) {
    if (!error || length <= 0) return;
    std::strncpy(error, why.c_str(), (size_t)length - 1);
    error[length - 1] = 0;
}

static double since(std::chrono::steady_clock::time_point from) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - from).count();
}

extern "C" void kt_backend_init(void) {
    llama_backend_init();
    // Only what goes wrong is told, on the console.
    llama_log_set([](ggml_log_level level, const char *text, void *) {
        if (level >= GGML_LOG_LEVEL_WARN) fputs(text, stderr);
    }, nullptr);
}

extern "C" kt_model *kt_model_load(const char *path, int context, char *error, int error_length) {
    auto made = new kt_model();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 999;
    made->model = llama_model_load_from_file(path, mp);
    if (!made->model) { delete made; say(error, error_length, "the model could not be loaded"); return nullptr; }
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t)context;
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = 4;
    cp.n_threads_batch = 4;
    made->context = llama_init_from_model(made->model, cp);
    if (!made->context) { llama_model_free(made->model); delete made; say(error, error_length, "no room for the model's context"); return nullptr; }
    made->size = context;
    try {
        made->templates = common_chat_templates_init(made->model, "");
    } catch (const std::exception &e) {
        kt_model_free(made);
        say(error, error_length, std::string("the model's chat template could not be read: ") + e.what());
        return nullptr;
    }
    return made;
}

extern "C" void kt_model_free(kt_model *model) {
    if (!model) return;
    model->templates.reset();
    if (model->context) llama_free(model->context);
    if (model->model) llama_model_free(model->model);
    delete model;
}

extern "C" void kt_free(char *text) { free(text); }

extern "C" char *kt_answer(kt_model *m, const kt_message *messages, int count, kt_settings settings, kt_outcome *outcome,
                           volatile int *cancel, char *error, int error_length) {
    kt_outcome done = {};
    try {
        common_chat_templates_inputs inputs;
        for (int i = 0; i < count; i++) {
            common_chat_msg message;
            message.role = messages[i].role;
            message.content = messages[i].content;
            inputs.messages.push_back(message);
        }
        inputs.add_generation_prompt = true;
        inputs.use_jinja = true;
        inputs.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
        if (settings.enable_thinking >= 0) {
            inputs.enable_thinking = settings.enable_thinking != 0;
            inputs.chat_template_kwargs["enable_thinking"] = settings.enable_thinking ? "true" : "false";
        }
        common_chat_params chat = common_chat_templates_apply(m->templates.get(), inputs);

        const llama_vocab *vocab = llama_model_get_vocab(m->model);
        std::vector<llama_token> prompt = common_tokenize(vocab, chat.prompt, true, true);
        int room = m->size - (int)prompt.size();
        if (prompt.empty() || room < 16) { say(error, error_length, "the request is longer than the model's room"); return nullptr; }
        int most = settings.max_tokens > 0 ? std::min(settings.max_tokens, room) : room;

        llama_memory_clear(llama_get_memory(m->context), true);
        auto began = std::chrono::steady_clock::now();
        for (size_t at = 0; at < prompt.size(); at += 512) {
            int n = (int)std::min<size_t>(512, prompt.size() - at);
            if (llama_decode(m->context, llama_batch_get_one(prompt.data() + at, n)) != 0) {
                say(error, error_length, "the model could not read the request");
                return nullptr;
            }
        }
        done.read_tokens = (int)prompt.size();
        done.read_ms = since(began);

        common_params_sampling sampling;
        sampling.temp = settings.temperature;
        sampling.top_p = settings.top_p;
        sampling.top_k = settings.top_k;
        sampling.penalty_repeat = settings.repeat_penalty;
        sampling.seed = settings.seed;
        common_sampler *sampler = common_sampler_init(m->model, sampling);

        std::vector<std::string> stops;
        for (int i = 0; i < settings.stop_count; i++) stops.push_back(settings.stops[i]);
        for (const auto &stop : chat.additional_stops) stops.push_back(stop);

        std::string written;
        auto writing = std::chrono::steady_clock::now();
        done.finish = 1;
        for (int n = 0; n < most; n++) {
            if (cancel && *cancel) { done.finish = 2; break; }
            llama_token token = common_sampler_sample(sampler, m->context, -1);
            common_sampler_accept(sampler, token, true);
            if (llama_vocab_is_eog(vocab, token)) { done.finish = 0; break; }
            written += common_token_to_piece(m->context, token, false);
            done.written_tokens++;
            bool stopped = false;
            for (const auto &stop : stops) {
                size_t at = written.find(stop);
                if (!stop.empty() && at != std::string::npos) { written.resize(at); stopped = true; break; }
            }
            if (stopped) { done.finish = 0; break; }
            if (llama_decode(m->context, llama_batch_get_one(&token, 1)) != 0) { done.finish = 0; break; }
        }
        done.written_ms = since(writing);
        common_sampler_free(sampler);

        // What the model wrote, read as the server reads it: its thinking, where it thought, taken out.
        std::string text = written;
        try {
            common_chat_parser_params parsing(chat);
            parsing.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
            parsing.parse_tool_calls = false;
            text = common_chat_parse(written, false, parsing).content;
        } catch (...) {
            size_t end = written.rfind("</think>");
            if (end != std::string::npos) text = written.substr(end + 8);
        }
        if (outcome) *outcome = done;
        char *out = (char *)malloc(text.size() + 1);
        std::memcpy(out, text.c_str(), text.size() + 1);
        return out;
    } catch (const std::exception &e) {
        say(error, error_length, std::string("the model could not answer: ") + e.what());
        return nullptr;
    }
}
