#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <spawn.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ALLOWED_SCRIPTS_CAPACITY (PATH_MAX * 16)

static int guard_active = 0;
static char pinned_python[PATH_MAX];
static char pinned_node[PATH_MAX];
static char pinned_git[PATH_MAX];
static char pinned_repository[PATH_MAX];
static char pinned_ld_preload[PATH_MAX];
static char pinned_pythonpath[PATH_MAX];
static char pinned_node_options[PATH_MAX * 2];
static char pinned_path[PATH_MAX * 2];
static char allowed_scripts[ALLOWED_SCRIPTS_CAPACITY];

static int install_network_seccomp(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#ifdef __NR_sendmmsg
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        return -1;
    }
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static void copy_resolved_environment(const char *name, char *destination) {
    const char *value = getenv(name);
    if (value == NULL || realpath(value, destination) == NULL) {
        destination[0] = '\0';
    }
}

static void copy_environment(const char *name, char *destination, size_t capacity) {
    const char *value = getenv(name);
    if (value == NULL || strlen(value) >= capacity) {
        destination[0] = '\0';
    } else {
        strcpy(destination, value);
    }
}

__attribute__((constructor)) static void initialize_guard(void) {
    const char *offline = getenv("QWEN_BASELINE_OFFLINE");
    guard_active = offline != NULL && strcmp(offline, "1") == 0;
    if (!guard_active) {
        return;
    }
    copy_resolved_environment("QWEN_BASELINE_PYTHON", pinned_python);
    copy_resolved_environment("QWEN_BASELINE_NODE", pinned_node);
    copy_resolved_environment("QWEN_BASELINE_GIT", pinned_git);
    copy_resolved_environment("QWEN_BASELINE_REPOSITORY", pinned_repository);
    copy_environment("LD_PRELOAD", pinned_ld_preload, sizeof(pinned_ld_preload));
    copy_environment("PYTHONPATH", pinned_pythonpath, sizeof(pinned_pythonpath));
    copy_environment("NODE_OPTIONS", pinned_node_options, sizeof(pinned_node_options));
    copy_environment("PATH", pinned_path, sizeof(pinned_path));
    const char *scripts = getenv("QWEN_BASELINE_ALLOWED_SCRIPTS");
    if (scripts == NULL || strlen(scripts) >= sizeof(allowed_scripts)) {
        allowed_scripts[0] = '\0';
    } else {
        strcpy(allowed_scripts, scripts);
    }
    if (install_network_seccomp() != 0) {
        static const char message[] = "deterministic baseline could not install network isolation\n";
        write(STDERR_FILENO, message, sizeof(message) - 1);
        _exit(126);
    }
}

static int resolve_executable(const char *path, char *resolved) {
    if (path == NULL) {
        return 0;
    }
    if (strchr(path, '/') != NULL) {
        return realpath(path, resolved) != NULL;
    }
    const char *search_path = getenv("PATH");
    if (search_path == NULL) {
        return 0;
    }
    const char *cursor = search_path;
    while (*cursor != '\0') {
        const char *separator = strchr(cursor, ':');
        size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
        char candidate[PATH_MAX];
        if (length > 0 && length + strlen(path) + 2 < sizeof(candidate)) {
            memcpy(candidate, cursor, length);
            candidate[length] = '/';
            strcpy(candidate + length + 1, path);
            if (access(candidate, X_OK) == 0 && realpath(candidate, resolved) != NULL) {
                return 1;
            }
        }
        if (separator == NULL) {
            break;
        }
        cursor = separator + 1;
    }
    return 0;
}

static int approved_script(const char *argument) {
    char resolved[PATH_MAX];
    if (argument == NULL || realpath(argument, resolved) == NULL) {
        return 0;
    }
    size_t resolved_length = strlen(resolved);
    const char *cursor = allowed_scripts;
    while (*cursor != '\0') {
        const char *separator = strchr(cursor, ':');
        size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
        if (length == resolved_length && strncmp(cursor, resolved, length) == 0) {
            return 1;
        }
        if (separator == NULL) {
            break;
        }
        cursor = separator + 1;
    }
    return 0;
}

static int approved_git_arguments(char *const argv[]) {
    if (argv[1] == NULL || argv[2] == NULL || argv[3] == NULL) {
        return 0;
    }
    if (strcmp(argv[1], "-C") != 0 || strcmp(argv[2], pinned_repository) != 0) {
        return 0;
    }
    return strcmp(argv[3], "cat-file") == 0
        || strcmp(argv[3], "show-ref") == 0
        || strcmp(argv[3], "rev-parse") == 0
        || strcmp(argv[3], "show") == 0;
}

static const char *environment_value(char *const envp[], const char *name) {
    if (envp == NULL) {
        return NULL;
    }
    size_t length = strlen(name);
    for (size_t index = 0; envp[index] != NULL; index++) {
        if (strncmp(envp[index], name, length) == 0 && envp[index][length] == '=') {
            return envp[index] + length + 1;
        }
    }
    return NULL;
}

static int environment_matches(
    char *const envp[],
    const char *name,
    const char *expected
) {
    const char *actual = environment_value(envp, name);
    return actual != NULL && strcmp(actual, expected) == 0;
}

static int environment_preserves_guard(char *const envp[]) {
    return environment_matches(envp, "QWEN_BASELINE_OFFLINE", "1")
        && environment_matches(envp, "QWEN_BASELINE_REPOSITORY", pinned_repository)
        && environment_matches(envp, "QWEN_BASELINE_PYTHON", pinned_python)
        && environment_matches(envp, "QWEN_BASELINE_NODE", pinned_node)
        && environment_matches(envp, "QWEN_BASELINE_GIT", pinned_git)
        && environment_matches(
            envp,
            "QWEN_BASELINE_ALLOWED_SCRIPTS",
            allowed_scripts
        )
        && environment_matches(envp, "LD_PRELOAD", pinned_ld_preload)
        && environment_matches(envp, "PYTHONPATH", pinned_pythonpath)
        && environment_matches(envp, "NODE_OPTIONS", pinned_node_options)
        && environment_matches(envp, "PATH", pinned_path);
}

static int approved_exec(const char *path, char *const argv[]) {
    char resolved[PATH_MAX];
    if (argv == NULL || !resolve_executable(path, resolved)) {
        return 0;
    }
    if (strcmp(resolved, pinned_python) == 0 || strcmp(resolved, pinned_node) == 0) {
        return approved_script(argv[1]);
    }
    return strcmp(resolved, pinned_git) == 0 && approved_git_arguments(argv);
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
    if (guard_active) {
        errno = EPERM;
        return -1;
    }
    static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
    if (real_connect == NULL) {
        real_connect = dlsym(RTLD_NEXT, "connect");
    }
    return real_connect(socket_fd, address, length);
}

ssize_t sendto(
    int socket_fd,
    const void *buffer,
    size_t size,
    int flags,
    const struct sockaddr *address,
    socklen_t length
) {
    if (guard_active) {
        errno = EPERM;
        return -1;
    }
    static ssize_t (*real_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t) = NULL;
    if (real_sendto == NULL) {
        real_sendto = dlsym(RTLD_NEXT, "sendto");
    }
    return real_sendto(socket_fd, buffer, size, flags, address, length);
}

ssize_t sendmsg(int socket_fd, const struct msghdr *message, int flags) {
    if (guard_active) {
        errno = EPERM;
        return -1;
    }
    static ssize_t (*real_sendmsg)(int, const struct msghdr *, int) = NULL;
    if (real_sendmsg == NULL) {
        real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
    }
    return real_sendmsg(socket_fd, message, flags);
}

int sendmmsg(int socket_fd, struct mmsghdr *messages, unsigned int count, int flags) {
    if (guard_active) {
        errno = EPERM;
        return -1;
    }
    static int (*real_sendmmsg)(int, struct mmsghdr *, unsigned int, int) = NULL;
    if (real_sendmmsg == NULL) {
        real_sendmmsg = dlsym(RTLD_NEXT, "sendmmsg");
    }
    return real_sendmmsg(socket_fd, messages, count, flags);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
    static int (*real_execve)(const char *, char *const[], char *const[]) = NULL;
    if (real_execve == NULL) {
        real_execve = dlsym(RTLD_NEXT, "execve");
    }
    if (
        guard_active
        && (!approved_exec(path, argv) || !environment_preserves_guard(envp))
    ) {
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
    if (
        guard_active
        && (!approved_exec(path, argv) || !environment_preserves_guard(envp))
    ) {
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
    if (
        guard_active
        && (!approved_exec(path, argv) || !environment_preserves_guard(envp))
    ) {
        return EPERM;
    }
    return real_posix_spawnp(pid, path, actions, attributes, argv, envp);
}
