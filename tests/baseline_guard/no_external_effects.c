#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <spawn.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int baseline_enabled(void) {
    const char *value = getenv("QWEN_BASELINE_OFFLINE");
    return value != NULL && strcmp(value, "1") == 0;
}

static const char *base_name(const char *path) {
    const char *slash = path == NULL ? NULL : strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

static int approved_script(const char *argument) {
    const char *repository = getenv("QWEN_BASELINE_REPOSITORY");
    if (repository == NULL || argument == NULL) {
        return 0;
    }
    char resolved[PATH_MAX];
    if (realpath(argument, resolved) == NULL) {
        return 0;
    }
    const char *allowed[] = {
        "scripts/visual_gate.py",
        "scripts/audit_project_skills.py",
        "scripts/compute_skill_folder_hash.mjs",
        "tests/baseline_guard/probe_python_network.py",
        "tests/baseline_guard/probe_python_descendant.py",
        "tests/baseline_guard/probe_python_model.py",
        "tests/baseline_guard/probe_node_network.cjs",
        "tests/baseline_guard/probe_node_descendant.cjs",
    };
    size_t repository_length = strlen(repository);
    for (size_t index = 0; index < sizeof(allowed) / sizeof(allowed[0]); index++) {
        if (strncmp(resolved, repository, repository_length) == 0
            && resolved[repository_length] == '/'
            && strcmp(resolved + repository_length + 1, allowed[index]) == 0) {
            return 1;
        }
    }
    return 0;
}

static int approved_exec(const char *path, char *const argv[]) {
    const char *name = base_name(path);
    if (name == NULL || argv == NULL || argv[1] == NULL) {
        return 0;
    }
    if (strncmp(name, "python", 6) == 0 || strcmp(name, "node") == 0) {
        return approved_script(argv[1]);
    }
    if (strcmp(name, "git") == 0 && argv[1] != NULL && argv[2] != NULL && argv[3] != NULL) {
        const char *repository = getenv("QWEN_BASELINE_REPOSITORY");
        if (repository == NULL || strcmp(argv[1], "-C") != 0 || strcmp(argv[2], repository) != 0) {
            return 0;
        }
        return strcmp(argv[3], "cat-file") == 0
            || strcmp(argv[3], "show-ref") == 0
            || strcmp(argv[3], "rev-parse") == 0
            || strcmp(argv[3], "show") == 0;
    }
    return 0;
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
    if (baseline_enabled()) {
        errno = EPERM;
        return -1;
    }
    static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
    if (real_connect == NULL) {
        real_connect = dlsym(RTLD_NEXT, "connect");
    }
    return real_connect(socket_fd, address, length);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
    static int (*real_execve)(const char *, char *const[], char *const[]) = NULL;
    if (real_execve == NULL) {
        real_execve = dlsym(RTLD_NEXT, "execve");
    }
    if (baseline_enabled() && !approved_exec(path, argv)) {
        errno = EPERM;
        return -1;
    }
    return real_execve(path, argv, envp);
}

int posix_spawn(
    pid_t *pid,
    const char *path,
    const posix_spawn_file_actions_t *actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    static int (*real_posix_spawn)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const[], char *const[]) = NULL;
    if (real_posix_spawn == NULL) {
        real_posix_spawn = dlsym(RTLD_NEXT, "posix_spawn");
    }
    if (baseline_enabled() && !approved_exec(path, argv)) {
        return EPERM;
    }
    return real_posix_spawn(pid, path, actions, attributes, argv, envp);
}

int posix_spawnp(
    pid_t *pid,
    const char *path,
    const posix_spawn_file_actions_t *actions,
    const posix_spawnattr_t *attributes,
    char *const argv[],
    char *const envp[]
) {
    static int (*real_posix_spawnp)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const[], char *const[]) = NULL;
    if (real_posix_spawnp == NULL) {
        real_posix_spawnp = dlsym(RTLD_NEXT, "posix_spawnp");
    }
    if (baseline_enabled() && !approved_exec(path, argv)) {
        return EPERM;
    }
    return real_posix_spawnp(pid, path, actions, attributes, argv, envp);
}
